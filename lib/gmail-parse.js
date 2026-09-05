// Helpers for turning a raw Gmail API message resource into plain, usable text.

function decodeBase64Url(data) {
  if (!data) return "";
  return Buffer.from(data, "base64url").toString("utf-8");
}

// Walks the MIME part tree and returns the first text/plain body it finds,
// falling back to a stripped-down version of text/html if no plain part exists.
function extractBodies(payload) {
  let plain = "";
  let html = "";

  function walk(part) {
    if (!part) return;
    const mimeType = part.mimeType || "";
    if (mimeType === "text/plain" && part.body && part.body.data) {
      plain += decodeBase64Url(part.body.data);
    } else if (mimeType === "text/html" && part.body && part.body.data) {
      html += decodeBase64Url(part.body.data);
    }
    if (Array.isArray(part.parts)) {
      part.parts.forEach(walk);
    }
  }

  walk(payload);

  if (!plain && html) {
    plain = html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
  }

  return { plain: plain.trim(), html };
}

function getHeader(payload, name) {
  const headers = (payload && payload.headers) || [];
  const found = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return found ? found.value : "";
}

function listAttachments(payload) {
  const out = [];
  function walk(part) {
    if (!part) return;
    if (part.filename && part.body && part.body.attachmentId) {
      out.push({
        filename: part.filename,
        mimeType: part.mimeType,
        attachmentId: part.body.attachmentId,
        size: part.body.size || 0,
      });
    }
    if (Array.isArray(part.parts)) part.parts.forEach(walk);
  }
  walk(payload);
  return out;
}

// Trims plain text to a sane length so a single message can't blow out a tool
// response the way raw Gmail bodies did when read through the built-in connector.
function trimText(text, maxChars) {
  if (!text) return text;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n...[truncated, ${text.length - maxChars} more characters]`;
}

function summarizeMessage(msg, { maxBodyChars = 4000 } = {}) {
  const payload = msg.payload || {};
  const { plain } = extractBodies(payload);
  return {
    id: msg.id,
    threadId: msg.threadId,
    date: getHeader(payload, "Date"),
    from: getHeader(payload, "From"),
    to: getHeader(payload, "To"),
    subject: getHeader(payload, "Subject"),
    snippet: msg.snippet || "",
    body: trimText(plain, maxBodyChars),
    attachments: listAttachments(payload),
  };
}

module.exports = { decodeBase64Url, extractBodies, getHeader, listAttachments, trimText, summarizeMessage };
