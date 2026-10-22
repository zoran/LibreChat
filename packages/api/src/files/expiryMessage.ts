import {
  escapeMailHtml as escape,
  MAIL_FONT_FAMILY,
  mailPresentation,
} from '../auth/mailPresentation';
import { mailClientUrl } from '../auth/emailCodeLink';

/** Presentation projection supplied by the File owner; this module never derives lifecycle state. */
type ActivityCount =
  | Readonly<{ known: true; value: number; coverage: 'complete' }>
  | Readonly<{ known: true; value: number; coverage: 'since'; since: string }>
  | Readonly<{ known: false }>;

type Inactivity =
  | Readonly<{
      known: true;
      since: string;
      fullDays: number;
      basis: 'successful-use' | 'upload';
    }>
  | Readonly<{ known: false }>;

export type ExpiryMessageInput = Readonly<{
  appTitle: string;
  offsetDays: 7 | 1;
  asOf: string;
  timezone: string;
  clientUrl?: string;
  embeddedLogo?: boolean;
  supportText?: string;
  late?: boolean;
  files: readonly Readonly<{
    filename: string;
    acceptedAt: string | null;
    lastSuccessfulReadAt: string | null;
    lastReadKnown: boolean;
    readCount: ActivityCount;
    processingCount: ActivityCount;
    inactivity: Inactivity;
    deadlineAt: string;
  }>[];
}>;

const invalid = () => new Error('Invalid expiry mail presentation');
function requireDisplay(condition: unknown): asserts condition {
  if (!condition) throw invalid();
}

const controls = /[\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/;
function hasControls(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return controls.test(value);
}
function textField(value: unknown): asserts value is string {
  requireDisplay(typeof value === 'string' && value.trim().length > 0 && !hasControls(value));
}

function instant(value: unknown): number {
  requireDisplay(
    typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value),
  );
  const timestamp = Date.parse(value);
  requireDisplay(Number.isFinite(timestamp));
  requireDisplay(
    Number(value.slice(11, 13)) < 24 &&
      Number(value.slice(14, 16)) < 60 &&
      Number(value.slice(17, 19)) < 60 &&
      new Date(`${value.slice(0, 10)}T00:00:00.000Z`).toISOString().slice(0, 10) ===
        value.slice(0, 10),
  );
  return timestamp;
}

function validateCount(count: ActivityCount): void {
  requireDisplay(count && typeof count === 'object' && typeof count.known === 'boolean');
  if (!count.known) return;
  requireDisplay(Number.isSafeInteger(count.value) && count.value >= 0);
  requireDisplay(count.coverage === 'complete' || count.coverage === 'since');
  if (count.coverage === 'since') instant(count.since);
}

function validate(input: ExpiryMessageInput): string | undefined {
  requireDisplay(input && typeof input === 'object');
  textField(input.appTitle);
  textField(input.timezone);
  instant(input.asOf);
  requireDisplay(input.offsetDays === 7 || input.offsetDays === 1);
  requireDisplay(input.late === undefined || typeof input.late === 'boolean');
  requireDisplay(input.embeddedLogo === undefined || typeof input.embeddedLogo === 'boolean');
  if (input.supportText !== undefined) textField(input.supportText);
  requireDisplay(Array.isArray(input.files) && input.files.length > 0);
  for (const file of input.files) {
    requireDisplay(file && typeof file === 'object');
    requireDisplay(typeof file.filename === 'string' && file.filename.trim().length > 0);
    if (file.acceptedAt !== null) instant(file.acceptedAt);
    if (file.lastSuccessfulReadAt !== null) instant(file.lastSuccessfulReadAt);
    requireDisplay(typeof file.lastReadKnown === 'boolean');
    instant(file.deadlineAt);
    validateCount(file.readCount);
    validateCount(file.processingCount);
    if (
      file.readCount.known &&
      file.readCount.coverage === 'complete' &&
      file.readCount.value === 0
    ) {
      requireDisplay(file.lastSuccessfulReadAt === null);
    }
    if (file.lastReadKnown && file.lastSuccessfulReadAt === null) {
      requireDisplay(
        file.readCount.known &&
          file.readCount.coverage === 'complete' &&
          file.readCount.value === 0,
      );
    }
    requireDisplay(
      file.inactivity &&
        typeof file.inactivity === 'object' &&
        typeof file.inactivity.known === 'boolean',
    );
    if (file.inactivity.known) {
      instant(file.inactivity.since);
      requireDisplay(
        Number.isSafeInteger(file.inactivity.fullDays) && file.inactivity.fullDays >= 0,
      );
      requireDisplay(
        file.inactivity.basis === 'successful-use' || file.inactivity.basis === 'upload',
      );
    }
  }
  return input.clientUrl === undefined ? undefined : mailClientUrl(input.clientUrl);
}

function inactivityText(value: Inactivity): string {
  if (!value.known)
    return 'Wie lange diese Datei nicht verwendet wurde, ist nicht vollständig erfasst.';
  if (value.fullDays === 0) {
    return value.basis === 'upload'
      ? 'Diese Datei wurde vor weniger als einem Tag hochgeladen und seitdem noch nicht verwendet.'
      : 'Diese Datei wurde vor weniger als einem Tag zuletzt verwendet.';
  }
  const days =
    value.fullDays === 1
      ? 'einem Tag'
      : `${new Intl.NumberFormat('de-DE').format(value.fullDays)} Tagen`;
  return value.basis === 'upload'
    ? `Seit dem Upload vor ${days} wurde diese Datei noch nicht verwendet.`
    : `Diese Datei wurde seit ${days} nicht mehr verwendet.`;
}

/** No clock, counters, deadline arithmetic, recipient selection, I/O or delivery authorization. */
export function expiryMessage(input: ExpiryMessageInput): {
  subject: string;
  text: string;
  html: string;
} {
  try {
    const clientUrl = validate(input);
    const date = new Intl.DateTimeFormat('de-DE', {
      timeZone: input.timezone,
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    const time = new Intl.DateTimeFormat('de-DE', {
      timeZone: input.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const offset = new Intl.DateTimeFormat('de-DE', {
      timeZone: input.timezone,
      timeZoneName: 'shortOffset',
    });
    const day = (value: string) => date.format(instant(value));
    const datetime = (value: string) => {
      const timestamp = instant(value);
      const suffix =
        input.timezone === 'UTC'
          ? 'UTC'
          : `${input.timezone}, ${offset.formatToParts(timestamp).find((part) => part.type === 'timeZoneName')!.value}`;
      return `${date.format(timestamp)} um ${time.format(timestamp)} Uhr (${suffix})`;
    };
    const count = (value: ActivityCount) => {
      if (!value.known) return 'Nicht erfasst';
      const number = new Intl.NumberFormat('de-DE').format(value.value);
      return value.coverage === 'since'
        ? `${number} seit ${day(value.since)}; frühere Vorgänge nicht erfasst`
        : number;
    };
    const lastRead = (file: ExpiryMessageInput['files'][number]) => {
      if (file.lastSuccessfulReadAt !== null) {
        return file.lastReadKnown
          ? day(file.lastSuccessfulReadAt)
          : `${day(file.lastSuccessfulReadAt)}; frühere Lesezugriffe nicht erfasst`;
      }
      if (file.lastReadKnown) return 'Noch kein erfolgreicher Lesezugriff';
      if (
        file.readCount.known &&
        file.readCount.coverage === 'since' &&
        file.readCount.value === 0
      ) {
        return `Keine erfolgreichen Lesezugriffe seit ${day(file.readCount.since)}; frühere Lesezugriffe nicht erfasst`;
      }
      return 'Nicht erfasst';
    };
    // Keep control and directional characters visible without letting names impersonate other fields.
    const filename = (value: string) =>
      Array.from(value, (character) =>
        hasControls(character)
          ? `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
          : character,
      ).join('');
    const files = input.files.map((file) => ({
      filename: filename(file.filename),
      inactivity: inactivityText(file.inactivity),
      fields: [
        ['Hochgeladen am', file.acceptedAt === null ? 'Nicht erfasst' : day(file.acceptedAt)],
        ['Letzter erfolgreicher Lesezugriff', lastRead(file)],
        ['Erfolgreiche Lesezugriffe', count(file.readCount)],
        ['Erfolgreiche Verarbeitungen', count(file.processingCount)],
        ['Vorgesehene Löschung ohne weitere Nutzung', datetime(file.deadlineAt)],
      ],
    }));
    const period = input.offsetDays === 7 ? 'sieben Tagen' : 'einem Tag';
    const subject = input.late
      ? `${input.appTitle}: Erinnerung an die geplante Löschung deiner Dateien`
      : `${input.appTitle}: Dateien in ${period} zur Löschung vorgesehen`;
    const heading =
      input.offsetDays === 7
        ? 'Geplante Löschung deiner Dateien'
        : 'Erinnerung an die geplante Löschung';
    const security = 'Die automatische Löschung erfolgt aus Sicherheitsgründen.';
    const intro = `Für die folgenden Dateien ist die automatische Löschung ${input.late ? 'zu den unten genannten Terminen' : `in ${period}`} vorgesehen, sofern du sie bis dahin nicht weiter erfolgreich liest oder verarbeitest.`;
    const overview = 'Deine Dateien im Überblick – Löschtermine ohne weitere Nutzung';
    const noAction = 'Wenn du die Dateien nicht mehr benötigst, musst du nichts tun.';
    const usage =
      'Jeder erfolgreiche Lese- oder Verarbeitungsvorgang verschiebt den bisher geltenden Löschtermin der jeweiligen Datei um weitere sieben Tage.';
    const snapshot = `Die genannten Termine und Angaben entsprechen dem Stand vom ${datetime(input.asOf)}. Den aktuellen Termin findest du in ${input.appTitle}.`;
    const open = `${input.appTitle} öffnen:`;
    const text = [
      subject,
      heading,
      security,
      intro,
      overview,
      ...files.map((file) =>
        [
          file.filename,
          file.inactivity,
          ...file.fields.map(([label, value]) => `${label}: ${value}`),
        ].join('\n'),
      ),
      noAction,
      usage,
      snapshot,
      ...(clientUrl ? [open, clientUrl] : []),
      ...(input.supportText ? [input.supportText] : []),
    ].join('\n\n');
    const font = MAIL_FONT_FAMILY;
    const paragraph = (value: string) =>
      `<p style="margin:0 0 16px;font-family:${font};font-size:16px;">${escape(value)}</p>`;
    const content = `<h1 style="margin:0 0 16px;font-family:${font};font-size:26px;line-height:1.3;color:#202124;">${escape(heading)}</h1>
<p style="margin:0 0 16px;font-family:${font};font-size:16px;"><strong>${escape(security)}</strong></p>
${paragraph(intro)}${paragraph(overview)}
${files
  .map(
    (
      file,
      index,
    ) => `<section aria-labelledby="expiry-file-${index + 1}" style="margin:0 0 20px;padding:16px;border:1px solid #D9DDE2;border-radius:8px;overflow-wrap:anywhere;word-break:break-word;font-family:${font};">
<h2 id="expiry-file-${index + 1}" style="margin:0 0 12px;font-family:${font};font-size:18px;line-height:1.4;overflow-wrap:anywhere;word-break:break-word;">${escape(file.filename)}</h2>
${paragraph(file.inactivity)}<dl style="margin:0;font-family:${font};">${file.fields.map(([label, value]) => `<dt style="margin:0;font-family:${font};font-size:14px;font-weight:bold;color:#4A4F57;">${escape(label)}</dt><dd style="margin:0 0 12px;font-family:${font};font-size:16px;overflow-wrap:anywhere;">${escape(value)}</dd>`).join('')}</dl></section>`,
  )
  .join('\n')}
${paragraph(noAction)}${paragraph(usage)}${clientUrl ? `${paragraph(open)}<a style="font-family:${font};font-size:14px;line-height:1.5;color:#4A4F57;text-decoration:underline;overflow-wrap:anywhere;word-break:break-all;" href="${escape(clientUrl)}">${escape(clientUrl)}</a>` : ''}`;
    const footer = `${escape(snapshot)}${input.supportText ? `<p style="margin:12px 0 0;font-family:${font};">${escape(input.supportText)}</p>` : ''}`;
    const html = mailPresentation({
      appTitle: input.appTitle,
      subject,
      language: 'de',
      embeddedLogo: input.embeddedLogo,
      content,
      footer,
    });
    return { subject, text, html };
  } catch {
    // Invalid snapshots are never silently completed with invented dates, zeroes or recipients.
    throw invalid();
  }
}
