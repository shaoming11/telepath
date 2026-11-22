#!/usr/bin/env python3

import argparse
import json
import re
from html import escape
from html.parser import HTMLParser
from pathlib import Path
from textwrap import dedent

ROOT = Path(__file__).resolve().parents[1]
SURFACES = {"PhoneMarkup": "public/index.html", "StageMarkup": "public/stage.html"}
DESTINATION = ROOT / "wasp-ui/src/generated"
VOID = frozenset("area base br col embed hr img input link meta param source track wbr".split())
BOOLEAN = frozenset(
    "allowfullscreen async autofocus autoplay checked controls default defer disabled "
    "formnovalidate hidden inert ismap loop multiple muted nomodule novalidate open playsinline "
    "readonly required reversed selected".split()
)
ATTRIBUTE = {name.lower(): name for name in (
    "allowFullScreen autoComplete autoFocus autoPlay cellPadding cellSpacing charSet "
    "colSpan crossOrigin enterKeyHint formAction formEncType formMethod formNoValidate "
    "formTarget frameBorder httpEquiv inputMode maxLength minLength noModule noValidate "
    "playsInline readOnly rowSpan spellCheck srcSet tabIndex useMap viewBox "
    "preserveAspectRatio gradientTransform gradientUnits markerHeight markerWidth "
    "patternContentUnits patternTransform patternUnits refX refY textLength "
    "lengthAdjust filterUnits clipPathUnits maskUnits maskContentUnits"
).split()}
ATTRIBUTE.update({"class": "className", "for": "htmlFor", "accept-charset": "acceptCharset"})
TAG = {name.lower(): name for name in (
    "clipPath linearGradient radialGradient textPath foreignObject feBlend feColorMatrix "
    "feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap "
    "feDistantLight feDropShadow feFlood feGaussianBlur feImage feMerge feMergeNode "
    "feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence"
).split()}
NUMBER = frozenset("cols colspan maxlength minlength rows rowspan size span tabindex".split())
INDENTATION = re.compile(r"^(?:[^\S\n]*\n)+[^\S\n]*$")
TEXT_EXPRESSION = re.compile(r"[<&>{}\t\n\r]|^\s|\s$")


def js_string(value):
    return json.dumps(value, ensure_ascii=False)


def camel_case(value):
    return re.sub(r"[:-]([a-z])", lambda match: match[1].upper(), value)


def styles(value):
    properties = {}
    for rule in value.split(";"):
        if not rule.strip():
            continue
        name, _, content = rule.partition(":")
        if not content.strip():
            raise ValueError(f"Invalid inline style: {rule!r}")
        name = name.strip()
        if name.startswith("--"):
            prop = name
        elif name.startswith("-ms-"):
            prop = camel_case(name[1:])
        else:
            prop = camel_case(name)
        properties[prop] = content.strip()
    return js_string(properties)


def prop(tag, name, value):
    if name.startswith("on"):
        raise ValueError(f"Unexpected inline handler on <{tag}>: {name}")
    react_name = ATTRIBUTE.get(name, camel_case(name) if not name.startswith(("aria-", "data-")) else name)
    if tag == "input":
        react_name = {"checked": "defaultChecked", "value": "defaultValue"}.get(name, react_name)
    if tag == "option" and name == "selected":
        raise ValueError("Move the option's selected value to the parent select's defaultValue.")
    if name == "style":
        return react_name + "={" + styles(value or "") + "}"
    if name in BOOLEAN:
        return react_name
    if name == "spellcheck" and value in {"true", "false"}:
        return react_name + "={" + value + "}"
    if name in NUMBER and value is not None and re.fullmatch(r"-?(?:0|[1-9][0-9]*)", value):
        return react_name + "={" + str(int(value)) + "}"
    return react_name + '="' + escape(value or "", quote=True) + '"'


class BodyToJsx(HTMLParser):
    def __init__(self):
        super().__init__()
        self.inside = False
        self.script = False
        self.open = []
        self.parts = []
        self.has_body = False

    def start(self, tag, attrs, self_closing):
        if tag == "body":
            if self.has_body:
                raise ValueError("Unexpected second body.")
            self.inside = True
            self.has_body = True
            return
        if not self.inside or self.script:
            return
        if tag == "script":
            self.script = not self_closing
            return
        if tag in {"html", "head", "style"}:
            raise ValueError(f"Unexpected <{tag}> inside body.")
        props = "".join(" " + prop(tag, name, value) for name, value in attrs)
        name = TAG.get(tag, tag)
        if tag in VOID or self_closing:
            self.parts.append("<" + name + props + " />")
        else:
            self.parts.append("<" + name + props + ">")
            self.open.append(tag)

    def handle_starttag(self, tag, attrs):
        self.start(tag, attrs, False)

    def handle_startendtag(self, tag, attrs):
        self.start(tag, attrs, True)

    def handle_endtag(self, tag):
        if not self.inside:
            return
        if self.script:
            if tag == "script":
                self.script = False
            return
        if tag == "body":
            if self.open:
                raise ValueError(f"Unclosed tags: {self.open}")
            self.inside = False
            return
        if not self.open or self.open[-1] != tag:
            raise ValueError(f"Unexpected closing tag </{tag}>.")
        self.open.pop()
        self.parts.append("</" + TAG.get(tag, tag) + ">")

    def handle_data(self, value):
        if not self.inside or self.script:
            return
        if INDENTATION.fullmatch(value):
            self.parts.append(value)
        elif value:
            self.parts.append("{" + js_string(value) + "}" if TEXT_EXPRESSION.search(value) else value)

    def markup(self):
        self.close()
        if not self.has_body or self.inside:
            raise ValueError("Expected exactly one complete body.")
        return dedent("".join(self.parts)).strip()


def generated(component, source):
    parser = BodyToJsx()
    parser.feed((ROOT / source).read_text())
    markup = parser.markup()
    imports = ""
    if component == "PhoneMarkup":
        markup, replacements = re.subn(
            r'<button[^>]* id="question-mode"[^>]*>[\s\S]*?</button>\s*'
            r'<section[^>]* id="live-pitch-notes"[^>]*>[\s\S]*?</section>',
            "<PhonePitchControls />",
            markup,
        )
        if replacements != 1:
            raise ValueError("Expected exactly one contiguous phone pitch control fragment.")
        imports = "import { PhonePitchControls } from '../PhonePitchControls';\n\n"
    lines = "\n".join("      " + line if line else "" for line in markup.splitlines())
    return (
        f"// Generated from {source}. Run python3 scripts/generate-wasp-surfaces.py after edits.\n"
        f"{imports}"
        f"export function {component}() {{\n"
        "  return (\n"
        "    <>\n"
        f"{lines}\n"
        "    </>\n"
        "  );\n"
        "}\n"
    )


def main():
    parser = argparse.ArgumentParser(description="Generate the React views used by the Wasp routes.")
    parser.add_argument("--check", action="store_true", help="Verify that the generated views are up to date.")
    args = parser.parse_args()
    stale = []
    for component, source in SURFACES.items():
        path = DESTINATION / (component + ".tsx")
        content = generated(component, source)
        if args.check:
            if not path.exists() or path.read_text() != content:
                stale.append(path.relative_to(ROOT))
        else:
            DESTINATION.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
    if stale:
        parser.error("regenerate stale views: " + ", ".join(map(str, stale)))


if __name__ == "__main__":
    main()
