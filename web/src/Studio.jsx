import React, { useEffect, useRef, useState } from "react";
import { HubProvider, useHub } from "./transport.jsx";
import { Stage } from "./Stage.jsx";
import "./design.css";

const beats = [
  {
    name: "Opening",
    title: "I have one minute to explain this.",
    caption: "A presents. B is sitting in the audience.",
    visual: "opening",
  },
  {
    name: "Whisper",
    title: "Slow down.",
    caption: "The coach sends a cue. The presenter hears it in their ear.",
    visual: "send",
  },
  {
    name: "Receipt",
    title: "I heard you.",
    caption: "A tap back lets the coach know the whisper landed.",
    visual: "receipt",
  },
  {
    name: "Private help",
    title: "Why does it need the Mac?",
    caption:
      "In Question Mode, the presenter can hear a private cue and answer in their own words.",
    visual: "question",
  },
  {
    name: "Approval",
    title: "Send this to your teammate?",
    caption: "The coach hears the draft first. A tap approves it for delivery.",
    visual: "preview",
  },
  {
    name: "Wrap",
    title: "Wrap it up now.",
    caption:
      "The coach sends the closing cue. The presenter finishes the pitch.",
    visual: "wrap",
  },
];

export function Brand() {
  return (
    <span className="brand">
      <img src="/mark.svg" alt="" width="27" height="27" />
      Telepathy
    </span>
  );
}

function Still({ beat }) {
  if (beat.visual === "opening")
    return (
      <figure className="hardware">
        <img
          src="/airpods.png"
          alt="First-generation AirPods and their charging case"
        />
      </figure>
    );
  if (beat.visual === "question" || beat.visual === "preview") {
    const coach = beat.visual === "preview";
    return (
      <div className={"listen " + (coach ? "blue" : "amber")}>
        <div className="ear-field">
          <span className="ear-disc">{coach ? "B" : "A"}</span>
        </div>
        <span>{coach ? "Coach only" : "Presenter only"}</span>
      </div>
    );
  }
  const back = beat.visual === "receipt";
  return (
    <div
      className="exchange"
      aria-label={
        back
          ? "Receipt from presenter A to coach B"
          : "Whisper from coach B to presenter A"
      }
    >
      <div className="receiver">
        <span className="seat-disc amber">A</span>
        <strong>Presenter</strong>
      </div>
      <div className={"path " + (back ? "return" : "outbound")}>
        <span>{back ? "Receipt" : "Whisper"}</span>
        <i />
      </div>
      <div className="receiver">
        <span className="seat-disc blue">B</span>
        <strong>Coach</strong>
      </div>
    </div>
  );
}

function Story() {
  const book = useRef(null);
  const position = useRef(0);
  const { link, state } = useHub();
  const ids = [...beats.map((b) => b.visual), "live-stage"];
  function go(index) {
    const target = ids[index];
    if (!target) return;
    if (location.hash !== "#" + target)
      history.pushState(null, "", "#" + target);
    const el = document.getElementById(target);
    el?.scrollIntoView({ block: "start", behavior: "instant" });
    el?.focus({ preventScroll: true });
    position.current = index;
  }
  useEffect(() => {
    const el = book.current;
    let pending = 0;
    function sync() {
      pending = 0;
      const top = el.getBoundingClientRect().top + el.clientHeight * 0.4;
      const items = Array.from(el.children);
      let active = 0;
      for (let i = 0; i < items.length; i++)
        if (items[i].getBoundingClientRect().top <= top) active = i;
      position.current = active;
      const hash = "#" + ids[active];
      if (location.hash !== hash) history.replaceState(null, "", hash);
    }
    const scroll = () => {
      if (!pending) pending = requestAnimationFrame(sync);
    };
    const restore = () => {
      const id = location.hash.slice(1);
      if (ids.includes(id)) {
        document
          .getElementById(id)
          ?.scrollIntoView({ block: "start", behavior: "instant" });
        position.current = ids.indexOf(id);
      }
    };
    const key = (event) => {
      const top = el.getBoundingClientRect().top + el.clientHeight * 0.4;
      const active = Array.from(el.children).reduce(
        (current, node, i) =>
          node.getBoundingClientRect().top <= top ? i : current,
        0,
      );
      if (
        event.repeat ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        document.querySelector("dialog[open]") ||
        event.target.closest("input,select,textarea,[contenteditable]")
      )
        return;
      if (
        event.key === "ArrowRight" ||
        (event.key === "PageDown" && active < beats.length)
      ) {
        event.preventDefault();
        go(active + 1);
      }
      if (
        event.key === "ArrowLeft" ||
        (event.key === "PageUp" && active < beats.length)
      ) {
        event.preventDefault();
        go(active - 1);
      }
    };
    restore();
    el.addEventListener("scroll", scroll, { passive: true });
    window.addEventListener("hashchange", restore);
    window.addEventListener("pageshow", restore);
    document.addEventListener("keydown", key);
    return () => {
      cancelAnimationFrame(pending);
      el.removeEventListener("scroll", scroll);
      window.removeEventListener("hashchange", restore);
      window.removeEventListener("pageshow", restore);
      document.removeEventListener("keydown", key);
    };
  }, []);
  return (
    <div className="story-book" ref={book} aria-label="Telepathy story">
      {beats.map((beat, index) => (
        <section
          tabIndex={-1}
          id={beat.visual}
          className={"story story-" + beat.visual}
          key={beat.visual}
          aria-labelledby={"title-" + beat.visual}
        >
          <header className="story-top">
            <Brand />
            <a className="story-link" href="#live-stage">
              Live stage <span aria-hidden="true">↗</span>
            </a>
          </header>
          <div className="story-content">
            <div className="story-copy">
              {index === 0 ? (
                <h1 id={"title-" + beat.visual}>{beat.title}</h1>
              ) : (
                <h2 id={"title-" + beat.visual}>{beat.title}</h2>
              )}
              <p>{beat.caption}</p>
            </div>
            <Still beat={beat} />
          </div>
          <footer className="story-foot">
            <nav aria-label={beat.name + " chapter navigation"}>
              {beats.map((item, i) => (
                <a
                  key={item.visual}
                  href={"#" + item.visual}
                  aria-current={index === i ? "step" : undefined}
                  aria-label={item.name}
                  title={item.name}
                >
                  <span />
                </a>
              ))}
            </nav>
            <span className="chapter-name">{beat.name}</span>
            <span className="story-hub">
              {link === "online" ? "Stage · " + state.phase : "Stage " + link}
            </span>
            <div className="pager">
              <button
                aria-label="Previous beat"
                disabled={!index}
                onClick={() => go(index - 1)}
              >
                ←
              </button>
              <button
                aria-label={
                  index === beats.length - 1 ? "Open live stage" : "Next beat"
                }
                onClick={() => go(index + 1)}
              >
                →
              </button>
            </div>
          </footer>
        </section>
      ))}
      <div tabIndex={-1} id="live-stage">
        <Stage back />
      </div>
    </div>
  );
}

export function Studio({ story }) {
  return <HubProvider>{story ? <Story /> : <Stage />}</HubProvider>;
}
