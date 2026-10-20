// Saves a web page to disk as readable markdown and tells the model only
// where it is and what headings it has, so the page never enters context.
//
// Install outside ~/.pi/agent/extensions. pi loads everything in that directory
// into every session; this is reached through
// subagents.defaultSubagentOnlyExtensions alone.

import fs from "node:fs/promises";
import path from "node:path";

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const MAX_OUTLINE = 200;
const USE_FETCH_CONTENT = "use fetch_content and get_search_content for this URL instead";

const DROPPED_BLOCKS = ["script", "style", "noscript", "svg", "template", "iframe", "nav", "footer", "aside", "head"];

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  eacute: "é",
  middot: "·",
  times: "×",
  rarr: "→",
  larr: "←",
};

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, "");
}

function resolveHref(href, base) {
  try {
    return new URL(decodeEntities(href), base).toString();
  } catch {
    return null;
  }
}

function dropBlocks(html) {
  let out = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of DROPPED_BLOCKS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, "gi"), "");
  }
  return out;
}

function mainRegion(html) {
  for (const tag of ["main", "article"]) {
    const m = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*)</${tag}\\s*>`, "i"));
    if (m) return m[1];
  }
  const body = html.match(/<body\b[^>]*>([\s\S]*)<\/body\s*>/i);
  return body ? body[1] : html;
}

export function htmlToMarkdown(html, baseUrl = "http://localhost/") {
  const pres = [];
  let text = mainRegion(dropBlocks(html));

  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, inner) => {
    const lang = inner.match(/class\s*=\s*["'][^"']*(?:language|lang)-([\w+-]+)/i);
    const code = decodeEntities(stripTags(inner.replace(/<br\s*\/?>/gi, "\n"))).replace(/^\n+|\s+$/g, "");
    pres.push("```" + (lang ? lang[1] : "") + "\n" + code + "\n```");
    return `<p>\u0000PRE${pres.length - 1}\u0000</p>`;
  });

  text = text.replace(/\s+/g, " ");

  text = text.replace(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi, (_, dq, sq, inner) => {
    const label = stripTags(inner).trim();
    const href = resolveHref(dq ?? sq, baseUrl);
    if (!label) return "";
    if (!href || !/^https?:/.test(href)) return label;
    return `[${label}](${href})`;
  });
  text = text.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, __, inner) => {
    const body = stripTags(inner).trim();
    return body ? `**${body}**` : "";
  });
  text = text.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_, __, inner) => {
    const body = stripTags(inner).trim();
    return body ? `*${body}*` : "";
  });
  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_, inner) => {
    const body = stripTags(inner);
    return body.trim() ? "`" + body.trim() + "`" : "";
  });

  text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, level, inner) => {
    const body = stripTags(inner).trim();
    return body ? `\n\n${"#".repeat(Number(level))} ${body}\n\n` : "";
  });
  text = text.replace(/<li\b[^>]*>/gi, "\n- ");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(td|th)\s*>/gi, " | ");
  text = text.replace(/<\/tr\s*>/gi, "\n");
  text = text.replace(/<blockquote\b[^>]*>/gi, "\n\n> ");
  text = text.replace(/<\/?(p|div|section|ul|ol|dl|dt|dd|table|thead|tbody|figure|figcaption|blockquote|hr|header|details|summary)\b[^>]*>/gi, "\n\n");

  text = decodeEntities(stripTags(text));

  const lines = text.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim());
  text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  text = text.replace(/\u0000PRE(\d+)\u0000/g, (_, i) => pres[Number(i)]);
  return text ? text + "\n" : "";
}

export function outlineOf(markdown) {
  const outline = [];
  let fenced = false;
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = lines[i].match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) outline.push({ line: i + 1, level: m[1].length, text: m[2] });
  }
  return outline;
}

function refusal(url, contentType) {
  const host = url.hostname.toLowerCase();
  if (host === "github.com" || host === "gist.github.com") return "GitHub page";
  if (/(^|\.)(youtube\.com|youtu\.be|vimeo\.com)$/.test(host)) return "video page";
  if (/\.pdf$/i.test(url.pathname)) return "PDF";
  if (contentType) {
    if (/application\/pdf/i.test(contentType)) return "PDF";
    if (/^(video|audio|image)\//i.test(contentType)) return "media file";
  }
  return null;
}

function combinedSignal(signal) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function savePage({ url, path: target }, { fetchImpl = globalThis.fetch, signal, cwd } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`save_page: not a URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`save_page: only http and https URLs are supported; ${USE_FETCH_CONTENT}`);
  }
  if (typeof target !== "string" || target === "") throw new Error("save_page: path is required");
  const early = refusal(parsed, null);
  if (early) throw new Error(`save_page: ${early}; ${USE_FETCH_CONTENT}`);

  let response;
  try {
    response = await fetchImpl(parsed.toString(), {
      redirect: "follow",
      signal: combinedSignal(signal),
      headers: { "user-agent": "Mozilla/5.0 (compatible; save_page)", accept: "text/html,text/*;q=0.9,application/json;q=0.8,*/*;q=0.1" },
    });
  } catch (err) {
    throw new Error(`save_page: fetch failed: ${err.message}`);
  }
  if (!response.ok) throw new Error(`save_page: HTTP ${response.status} for ${parsed}`);

  const contentType = response.headers.get("content-type") ?? "";
  const late = refusal(parsed, contentType);
  if (late) throw new Error(`save_page: ${late}; ${USE_FETCH_CONTENT}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) throw new Error(`save_page: page is ${declared} bytes, over the ${MAX_BYTES} limit; ${USE_FETCH_CONTENT}`);

  const body = await response.text();
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error(`save_page: page is over the ${MAX_BYTES} byte limit; ${USE_FETCH_CONTENT}`);

  const isHtml = /html/i.test(contentType) || (!contentType && /^\s*(<!doctype html|<html)/i.test(body));
  const isText = /^text\/|json|markdown|xml/i.test(contentType) || !contentType;
  if (!isHtml && !isText) throw new Error(`save_page: unsupported content type ${contentType}; ${USE_FETCH_CONTENT}`);

  const markdown = isHtml ? htmlToMarkdown(body, response.url || parsed.toString()) : body;
  if (!markdown.trim()) throw new Error(`save_page: no readable text in ${parsed}; ${USE_FETCH_CONTENT}`);

  const file = path.resolve(cwd ?? process.cwd(), target);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, markdown);
  const outline = outlineOf(markdown);
  return {
    path: file,
    bytes: Buffer.byteLength(markdown),
    outline: outline.slice(0, MAX_OUTLINE),
    ...(outline.length > MAX_OUTLINE ? { outline_truncated: outline.length } : {}),
  };
}

export default function savePageExtension(pi, deps = {}) {
  pi.registerTool({
    name: "save_page",
    label: "Save page",
    description:
      "Fetch a web page, convert it to readable markdown and write it to a file. Returns the path, the byte count " +
      "and the heading outline with line numbers, never the page text: read the file in ranges afterwards. " +
      "Not for PDFs, videos or GitHub pages; use fetch_content for those.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "http or https URL of the page" },
        path: { type: "string", description: "Absolute path of the markdown file to write" },
      },
      required: ["url", "path"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const result = await savePage(params, { fetchImpl: deps.fetchImpl ?? globalThis.fetch, signal, cwd: ctx?.cwd });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
