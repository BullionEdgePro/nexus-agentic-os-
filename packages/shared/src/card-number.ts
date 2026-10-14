/**
 * Does this text contain a payment card number?
 *
 * The Business HQ vault keeps logins, not money (spec §5.6): a card number
 * typed into any of its fields is refused and pointed at a payment manager.
 * A card number is 13–19 digits, optionally grouped by spaces or dashes, that
 * passes the Luhn check — which a phone number or a password with digits in it
 * almost never does.
 */
export function looksLikeCardNumber(text: string): boolean {
  if (!text) return false;
  // Every run of digits (spaces and dashes allowed between them), and inside
  // each run every 13-19 digit window: a card pasted as "4111 1111 1111 1111
  // 12/27" or "+971 4111111111111111" sits inside a longer run, and testing only
  // the whole run let it through (final review, 14 Oct 2026).
  const runs = text.match(/\d(?:[ -]?\d)+/g) ?? [];
  return runs.some((run) => {
    const digits = run.replace(/[ -]/g, "");
    for (let len = 13; len <= 19; len++) {
      for (let start = 0; start + len <= digits.length; start++) {
        if (luhn(digits.slice(start, start + len)) && /^[2-6]/.test(digits[start])) return true;
      }
    }
    return false;
  });
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
