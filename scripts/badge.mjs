// Renders the README badge from a verification that actually ran.
//
// The badge is written from the same report the job summary is built from, so it
// can only ever say what the verifier found. That is the whole point: a badge
// pasted from a URL asserts whatever its author typed, while this one is a
// by-product of the check itself. It is written on failure too, and deliberately
// so. Skipping the write on a bad run would leave the previous green badge in
// place, which is the one outcome worse than no badge at all.
//
// It names the signer, never a bare checkmark, because "signed" must never be
// read as "safe" (see the badge note in the design doc). A green badge here
// means "these bytes came from this identity", nothing more.
//
// No external font, no network reference, no <image>: GitHub serves README
// images through a proxy that fetches once and strips anything live, so the file
// has to stand alone.

/** Approximate Verdana 11px advance widths, keyed by character.
 *
 *  Text is centred by computing its width, and a real font metric table is more
 *  than this needs. What matters is that the box is never narrower than the text
 *  it holds, so the estimate leans wide rather than exact. */
const NARROW = new Set(["'", '|', 'i', 'j', 'l', '.', ',', ':', ';', '!', '[', ']', '(', ')', ' ']);
const WIDE = new Set(['m', 'w', 'M', 'W', '@', '%']);

export function textWidth(text) {
  let w = 0;
  for (const ch of String(text)) {
    if (NARROW.has(ch)) w += 3.6;
    else if (WIDE.has(ch)) w += 10;
    else if (ch >= 'A' && ch <= 'Z') w += 8;
    else w += 6.6;
  }
  return Math.ceil(w);
}

const COLORS = { pass: '#2ea44f', warn: '#dfb317', fail: '#e05d44', unsigned: '#9f9f9f' };

const escapeXml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** Shorten a signer identity to something that fits a badge and still names who.
 *
 *  A keyless GitHub Actions identity is a workflow URL:
 *    https://github.com/OWNER/REPO/.github/workflows/sign.yml@refs/heads/main
 *  The part a reader needs is the repository it belongs to. An email identity
 *  (the Google and GitHub user flows) is already short and is kept as it is. */
export function shortIdentity(identity) {
  const id = String(identity ?? '').trim();
  if (!id) return '';
  if (!id.includes('://')) return truncate(id, 40);

  try {
    const url = new URL(id.split('@refs/')[0]);
    const parts = url.pathname.split('/').filter(Boolean);
    // Everything from `.github/…` onwards is the workflow, not the publisher.
    const cut = parts.findIndex((p) => p.startsWith('.'));
    const owned = (cut === -1 ? parts : parts.slice(0, cut)).slice(0, 2);
    return truncate([url.host, ...owned].join('/'), 40);
  } catch {
    return truncate(id, 40);
  }
}

function truncate(s, max) {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** The message half of the badge, derived only from the report.
 *
 *  A failure never names a signer: a bundle that fails to verify still carries
 *  an identity field, and printing it would credit a publisher the verifier just
 *  refused to establish. Same reason the job summary says "signer not
 *  established" rather than naming one. */
export function badgeText(results, counts) {
  if (counts.total === 0) return { message: 'nothing checked', color: COLORS.unsigned };
  if (counts.failed > 0) {
    return {
      message: counts.failed === counts.total ? 'signature invalid' : `${counts.failed} of ${counts.total} invalid`,
      color: COLORS.fail,
    };
  }

  const signers = [...new Set(results.filter((r) => r.signed && r.identity).map((r) => shortIdentity(r.identity)))];

  if (signers.length === 0) return { message: 'unsigned', color: COLORS.unsigned };
  // Some signed, some not. Saying "signed by X" would speak for the unsigned
  // ones too, so the count is the honest summary.
  if (counts.unsigned > 0) {
    const signedCount = counts.total - counts.unsigned;
    return { message: `${signedCount} of ${counts.total} signed`, color: COLORS.warn };
  }

  const color = counts.warned > 0 ? COLORS.warn : COLORS.pass;
  if (signers.length === 1) return { message: `signed by ${signers[0]}`, color };
  return { message: `signed by ${signers.length} publishers`, color };
}

/** A self-contained flat badge. `label | message`, the classic two-box shape. */
export function badgeSvg({ label = 'PromptSign', message, color }) {
  const pad = 10;
  const labelW = textWidth(label) + pad * 2;
  const msgW = textWidth(message) + pad * 2;
  const total = labelW + msgW;
  const alt = `${label}: ${message}`;

  // Text is drawn twice: once in near-black at 30% under the real glyphs, which
  // is the shadow that keeps light text legible on the mid-tone right box.
  const text = (content, x, width) => {
    const cx = (x + width / 2) * 10;
    const safe = escapeXml(content);
    return (
      `<text x="${cx}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(width - pad * 2) * 10}">${safe}</text>` +
      `<text x="${cx}" y="140" transform="scale(.1)" textLength="${(width - pad * 2) * 10}">${safe}</text>`
    );
  };

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${escapeXml(alt)}">` +
    `<title>${escapeXml(alt)}</title>` +
    '<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>' +
    `<clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>` +
    '<g clip-path="url(#r)">' +
    `<rect width="${labelW}" height="20" fill="#555"/>` +
    `<rect x="${labelW}" width="${msgW}" height="20" fill="${color}"/>` +
    `<rect width="${total}" height="20" fill="url(#s)"/>` +
    '</g>' +
    '<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="110">' +
    text(label, 0, labelW) +
    text(message, labelW, msgW) +
    '</g>' +
    '</svg>\n'
  );
}

/** What the action writes: the badge for this report. */
export function renderBadge(results, counts) {
  return badgeSvg(badgeText(results, counts));
}
