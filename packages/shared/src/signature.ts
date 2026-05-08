export interface AgentSignature {
  displayName: string;
  description: string | null;
  profileImageUrl: string | null;
  companyName?: string | null;
  companyWebsite?: string | null;
  /**
   * Thread handle rendered as a small `ref: <slug>` line at the very bottom of
   * the signature. Used for operator debugging — recipients can ignore it.
   * `"root"` for the root task, the per-task slug for child tasks.
   */
  threadRef?: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function buildSubtitle(signature: AgentSignature): string {
  const parts: string[] = [];
  if (signature.description?.trim()) parts.push(signature.description.trim());
  if (signature.companyName?.trim()) parts.push(signature.companyName.trim());
  return parts.join(" · ");
}

export function buildTextSignature(signature: AgentSignature): string {
  const lines: string[] = [signature.displayName];
  const subtitle = buildSubtitle(signature);
  if (subtitle) lines.push(subtitle);
  if (signature.companyWebsite?.trim()) {
    lines.push(`w  ${stripProtocol(signature.companyWebsite.trim())}`);
  }
  const ref = signature.threadRef?.trim();
  const refLine = ref ? `\nref: ${ref}\n` : "";
  return `\n\n-- \n${lines.join("\n")}\n${refLine}`;
}

export function buildHtmlSignature(signature: AgentSignature): string {
  const name = escapeHtml(signature.displayName);
  const subtitle = buildSubtitle(signature);

  const imgCell = signature.profileImageUrl
    ? `<td style="padding-right:16px;vertical-align:top;width:80px;">` +
      `<img src="${escapeHtml(signature.profileImageUrl)}" alt="${name}" width="80" height="80" ` +
      `style="display:block;width:80px;height:80px;border-radius:40px;object-fit:cover;border:0;" />` +
      `</td>`
    : "";

  const subtitleHtml = subtitle
    ? `<div style="color:#6b7280;font-size:14px;line-height:1.4;margin-top:2px;">${escapeHtml(subtitle)}</div>`
    : "";

  const website = signature.companyWebsite?.trim();
  const websiteHtml = website
    ? `<div style="height:1px;background:#e5e7eb;margin:10px 0 8px 0;max-width:260px;"></div>` +
      `<div style="font-size:13px;line-height:1.4;">` +
      `<span style="display:inline-block;color:#9ca3af;margin-right:10px;font-family:Georgia,serif;">w</span>` +
      `<a href="https://${escapeHtml(stripProtocol(website))}" style="color:#111;text-decoration:none;">${escapeHtml(stripProtocol(website))}</a>` +
      `</div>`
    : "";

  const ref = signature.threadRef?.trim();
  const refHtml = ref
    ? `<div style="color:#9ca3af;font-size:11px;margin-top:6px;">ref: ${escapeHtml(ref)}</div>`
    : "";

  const textCell =
    `<td style="vertical-align:top;font-family:Arial,Helvetica,sans-serif;">` +
    `<div style="color:#111;font-size:18px;font-weight:700;line-height:1.2;">${name}</div>` +
    subtitleHtml +
    websiteHtml +
    refHtml +
    `</td>`;

  return (
    `<br><br>` +
    `<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:8px;">` +
    `<tr>${imgCell}${textCell}</tr>` +
    `</table>`
  );
}
