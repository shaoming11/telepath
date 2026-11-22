const sameOriginHub =
  document.documentElement.dataset.telepathy === "rehearsal";
export const hubPrefix = sameOriginHub ? "" : "/hub";
export const storyUrl = sameOriginHub ? "/studio.html" : "/";
