export interface AgentSignature {
  displayName: string;
  description: string | null;
  profileImageUrl: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildTextSignature(signature: AgentSignature): string {
  const lines = [signature.displayName];
  if (signature.description && signature.description.trim()) {
    lines.push(signature.description.trim());
  }
  return `\n\n-- \n${lines.join("\n")}\n`;
}

export function buildHtmlSignature(signature: AgentSignature): string {
  const name = escapeHtml(signature.displayName);
  const description = signature.description?.trim()
    ? escapeHtml(signature.description.trim())
    : "";

  const imgCell = signature.profileImageUrl
    ? `<td style="padding-right:12px;vertical-align:middle;width:64px;">` +
      `<img src="${escapeHtml(signature.profileImageUrl)}" alt="${name}" width="64" height="64" ` +
      `style="display:block;width:64px;height:64px;border-radius:32px;object-fit:cover;border:0;" />` +
      `</td>`
    : "";

  const descHtml = description
    ? `<div style="color:#666;font-size:13px;line-height:1.4;margin-top:2px;">${description}</div>`
    : "";

  const textCell =
    `<td style="vertical-align:middle;font-family:Arial,Helvetica,sans-serif;">` +
    `<div style="color:#111;font-size:14px;font-weight:600;line-height:1.3;">${name}</div>` +
    descHtml +
    `</td>`;

  return (
    `<br><br>` +
    `<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:8px;">` +
    `<tr>${imgCell}${textCell}</tr>` +
    `</table>`
  );
}
