// Tonk links are bearer credentials (SPEC §8): anyone holding one can join
// the space. People paste them into chat ("join this <link>") and agents
// print them ("here is your invite"), so they are stripped from everything
// the recorder stores — prompts, responses and diffs — before it is queued.

export const LINK_REMOVED = "[tonk link removed]";

const RE_URL = /\bhttps?:\/\/[^\s"'<>`)\]}]+/gi;

function isTonkLink(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const host = u.hostname.toLowerCase();
  if (/(^|\.)tonk\.[a-z]+$/.test(host)) return true; // tonk.foundation, tonk.network, tonk.xyz, …
  if (/[?&#]access=/.test(url)) return true;
  // self-hosted deployments: a space / invite path carrying its key in the fragment
  return u.hash.length > 1 && /\/(space|join|invite|@)(\/|$)/.test(u.pathname);
}

/** @returns {{ text: string|null, removed: number }} */
export function stripLinks(text) {
  if (text == null) return { text, removed: 0 };
  let removed = 0;
  const out = String(text).replace(RE_URL, (url) => {
    if (!isTonkLink(url)) return url;
    removed++;
    return LINK_REMOVED;
  });
  return { text: out, removed };
}
