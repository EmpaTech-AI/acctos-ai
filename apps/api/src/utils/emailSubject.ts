/**
 * The name a Gmail-triggered job goes by. Everything downstream keys off the email
 * subject — the originals folder, the result folder and filename, the VAT header and
 * the result email — so an email sent with no subject used to be processed but then
 * filed as "_processed.xlsx" in the root folder, with no originals and no result email.
 * With no subject, fall back to the sender's display name ("Example Ltd" in
 * "Example Ltd <owner@example.com>"), or their address when there is no display name.
 */
export function subjectOrSender(subject: string | undefined, from: string): string {
    const s = (subject ?? '').trim();
    if (s) return s;
    const name = from.replace(/<[^>]*>/g, '').replace(/["*]/g, '').replace(/\s+/g, ' ').trim();
    if (name && !name.includes('@')) return name;
    const m = from.match(/<([^>]+)>/);
    return (m ? m[1] : from).trim();
}
