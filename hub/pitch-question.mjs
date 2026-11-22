import { questionKey } from './questions.mjs';
import { packReferenceEvidence } from './references.mjs';

const QUESTION = /(?:^|[.!?]\s+)(?:(?:so|and|okay|but)\s*[, ]\s*)?(?:why|how|what|where|when|who|which|can you|could you|would you|do you|are you|does (?:it|that)|is (?:there|it|this)|tell (?:me|us)|walk (?:me|us) through|explain)\b/i;
export const BUILD_STORY_CUE = 'Safari catches the AirPods gesture. The Mac routes messages and listens to the room. ElevenLabs transcribes, OpenAI drafts, and ElevenLabs whispers back.';
export const BUILD_STORY_EVIDENCE = 'Safari earbud controls, a Mac hub, and private cues written by OpenAI and voiced by ElevenLabs';
export const BUILD_STORY_NOTES = [
  'Safari turns the AirPods gesture into a browser event.',
  'The Mac routes signals and listens to the room.',
  'OpenAI drafts the cue. ElevenLabs whispers it privately.',
];

export function missingBuildPoint(answer) {
  const checks = [
    [/\b(?:safari|browser|iphone|phone)\b/i, /\b(?:tap|gesture|media|squeez)/i, 'Say how Safari catches the AirPods gesture.'],
    [/\b(?:macbook|mac|hub)\b/i, /\b(?:rout|listen|audio|microphone|coordinat)/i, 'Say the Mac routes messages and listens.'],
    [/\bopenai\b/i, /\b(?:draft|generat|writ|reason)/i, 'Mention that OpenAI drafts the private cue.'],
    [/\beleven\s*labs\b/i, /\b(?:transcrib|transcript|speak|voic|whisper|speech)/i, 'Mention that ElevenLabs transcribes and whispers.'],
  ];
  return checks.find(([name, mechanism]) => !name.test(answer) || !mechanism.test(answer))?.[2];
}

export function isBuildStoryQuestion(text) {
  const question = questionKey(text);
  return /\b(?:how (?:you|did you|the team)|walk (?:us|me) through)\b/.test(question)
    && /\b(?:build|built|develop|developed|development|made|make|created|create|put together)\b/.test(question)
    && /\b(?:(?:build|built|develop|developed|made|make|created|create|put together) (?:the |this |your )?(?:project|app|product|telepathy|it)|development of (?:the |this |your )?(?:project|app|product|telepathy))$/.test(question);
}

export function isFrontendStackQuestion(text) {
  const question = questionKey(text);
  return /\b(?:front ?end|user interface|ui)\b/.test(question)
    && (/\b(?:framework|stack|built with|made with|written in|powered by|runs on)\b/.test(question)
      || /^(?:how (?:did|do) you|what did you use to) (?:build|make|develop)\b/.test(question))
    || /^(?:are you using|do you use|is this (?:made|built|written) (?:with|in)) (?:react|wasp)\b/.test(question);
}

export function sourcedProjectCue(question, passages, frontendStack) {
  let answer, quote, source;
  if (frontendStack && isFrontendStackQuestion(question)) {
    [quote] = frontendStack.text.replace(/^#{1,4} [^\n]+\n+/, '').split(/\n\n/, 1);
    if (quote.length > 180 || quote.split(/\s+/).length > 20) return null;
    answer = quote;
    source = frontendStack;
  } else if (isBuildStoryQuestion(question)) {
    answer = BUILD_STORY_CUE;
    quote = BUILD_STORY_EVIDENCE;
  } else if (/\bopenai\b/i.test(question) && /\braw\b/i.test(question) && /\b(?:mic|microphone|audio|recording)\b/i.test(question)) {
    answer = 'ElevenLabs gets the room audio. OpenAI gets transcript text only.';
    quote = 'ElevenLabs alone receives raw mic audio; OpenAI receives transcript snapshots';
  } else if (/\bresponse\.create\b/i.test(question) && /\b(?:file|handler|sends?|where)\b/i.test(question)) {
    answer = 'The Realtime pitch adapter sends response create over the WebSocket.';
    quote = "type: 'response.create'";
    source = passages.find(passage => passage.name.startsWith('hub/realtime-pitch.mjs:') && passage.text.includes(quote));
    if (!source) return null;
  } else return null;
  source ??= passages.find(passage => passage.text.includes(quote));
  return source ? { status: 'answer', question, answer, sources: [{ id: source.id, quote }] } : null;
}

export function isUsefulPitchCue(cue, question) {
  const aboutSources = /\b(?:rag|grounding|grounded|sources?|citations?|retrieval|references?|documents?|deck|hallucinations?|accuracy|evidence)\b/i.test(question);
  return aboutSources || !/\b(?:grounded in|based on|backed by|using)\s+(?:(?:the|your|provided|available|project|relevant)\s+)*(?:references|sources|evidence|documents|context|data)\b/i.test(cue);
}

export function looksLikeQuestion(text) {
  const words = questionKey(text).split(' ').length;
  return text.includes('?') ? words >= 2 : words >= 3 && QUESTION.test(text);
}

const QUESTION_TOPICS = [
  [/\b(?:disconnect\w*|reconnect\w*|drops? out|lost connection)\b/i,
    'Mention that the phone rejoins the same take. Wait for Live and Cached before sending another cue.',
    'The phone rejoins the current take.'],
  [/\b(?:backend|back end|server architecture|node hub)\b/i,
    'Explain the Node hub: it holds session state, routes WebSocket signals, and calls the speech and AI providers.',
    'The Mac hub runs Node.js 22.13+ using standard HTTP/HTTPS, the ws package, and in-memory session state.'],
  [/\b(?:rag|retrieval|vector (?:database|search|store)|grounding)\b/i,
    'Explain how lexical and SQLite vector search retrieve project evidence for the current question.',
    'lexical and exact-code retrieval run alongside cosine search over hashed token vectors'],
  [/\b(?:connect|hotspot|wifi|wi fi)\b.*\b(?:phone|mac|hub)|\b(?:phone|mac|hub)\b.*\b(?:connect|hotspot|wifi|wi fi)/i,
    'Mention that both phones join the Mac on the same hotspot and send signals through WebSockets.',
    'Both phones join over the same hotspot using HTTPS and WebSockets.'],
];
export function roomCueTopicTerms(question) {
  return QUESTION_TOPICS.find(([pattern]) => pattern.test(question))?.[2] ?? '';
}
const FALLBACK_SENTENCES = new Intl.Segmenter('en', { granularity: 'sentence' });
const topicWords = text => questionKey(text).split(' ').filter(word => word.length > 3
  && !['what', 'about', 'explain', 'does', 'when', 'with', 'this', 'that', 'works', 'your', 'have', 'would', 'could', 'should', 'their', 'please', 'actually'].includes(word));

export function roomFallbackCue(question, passages, frontendStack, wearerAnswer = '') {
  if (!question) return { answer: 'Open with the problem. Show a teammate sending you one private cue.', sources: [] };
  if (!wearerAnswer) {
    const known = sourcedProjectCue(question, passages, frontendStack);
    if (known) return known;
    for (const [pattern, answer, quote] of QUESTION_TOPICS) {
      if (!pattern.test(question)) continue;
      const passage = passages.find(item => item.text.includes(quote));
      if (passage) return { answer, sources: [{ id: passage.id, name: passage.name, quote }] };
    }
  }
  const uttered = questionKey(wearerAnswer);
  const topics = new Set(topicWords(question));
  const fact = packReferenceEvidence(passages.filter(passage => passage.kind !== 'code'), question, 6)
    .flatMap(passage => [...FALLBACK_SENTENCES.segment(passage.text)].map(({ segment }) => ({
      passage, quote: segment.trim(), words: topicWords(segment),
    })))
    .filter(({ quote, words }) => quote.length >= 8 && quote.length <= 160 && !uttered.includes(questionKey(quote))
      && words.some(word => topics.has(word)))
    .sort((a, b) => b.words.filter(word => topics.has(word)).length - a.words.filter(word => topics.has(word)).length)[0];
  if (fact) return { answer: 'Mention this: ' + fact.quote,
    sources: [{ id: fact.passage.id, name: fact.passage.name, quote: fact.quote }] };
  const subject = [...topics].slice(-4).join(' ');
  return { answer: subject ? 'Ask which part of “' + subject + '” they want you to explain.'
    : 'Ask them to narrow this down to one specific point.', sources: [] };
}

export function sameQuestion(partial, final) {
  const normalize = value => questionKey(value).replace(/ (?:please|thanks|thank you)$/, '');
  return normalize(partial) === normalize(final);
}

// A draft from a partial transcript still fits when the final question only added a few closing words.
export function nearlySameQuestion(partial, final, maxExtraWords = 4) {
  const normalize = value => questionKey(value).replace(/ (?:please|thanks|thank you)$/, '');
  const draft = normalize(partial);
  const done = normalize(final);
  if (!draft || draft === done) return Boolean(draft);
  if (!(done + ' ').startsWith(draft + ' ')) return false;
  return done.split(' ').length - draft.split(' ').length <= maxExtraWords;
}

export function fallbackPitchCue(text, question = false) {
  if (isBuildStoryQuestion(text)) return BUILD_STORY_CUE;
  if (/\b(macbook|mac|microphone)\b/i.test(text)) return 'Mac listens. Phones keep earbud controls.';
  if (/\b(diarization|speakers?|speaker labels)\b/i.test(text)) return 'Anonymous speaker groups. Assign seats manually.';
  if (/\b(documents?|references?|pitch deck|slides)\b/i.test(text)) return 'Built-in brief. Add relevant uploaded notes.';
  if (/\b(privacy|stored|saved|retention)\b/i.test(text)) return 'Ephemeral hub. Relevant excerpts reach OpenAI.';
  return question ? 'Restate the question. Give one example.' : 'Show one private cue live.';
}
