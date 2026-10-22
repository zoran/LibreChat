/** Native DOCX parser agreement only; this is never complete-content inspection or approval. */
import type { JSDOM } from 'jsdom';

const relationshipsNS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const typesNS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const officeNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const mainType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

function invalid(): never {
  throw new Error('Invalid or ambiguous DOCX package');
}

function canonicalPart(value: string): boolean {
  return (
    value.length <= 1024 &&
    /^[A-Za-z0-9_[\]./-]+$/.test(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

/** All relationship IDs must be unique; relevant native reader targets must be unambiguous. */
function relationships(document: Document): Element[] {
  const root = document.documentElement;
  if (root.namespaceURI !== relationshipsNS || root.localName !== 'Relationships') invalid();
  const ids = new Set<string>();
  return Array.from(root.children).map((node) => {
    const id = node.getAttribute('Id');
    if (
      node.namespaceURI !== relationshipsNS ||
      node.localName !== 'Relationship' ||
      node.children.length !== 0 ||
      !id ||
      ids.has(id) ||
      !node.getAttribute('Type') ||
      !node.getAttribute('Target')
    )
      invalid();
    ids.add(id);
    return node;
  });
}

/** Require the exact main document/content type used by both fixed XML structure and Mammoth. */
export function assertCanonicalDocxPackage(
  parts: ReadonlyMap<string, Buffer>,
  parseXml: (data: Buffer | undefined) => JSDOM,
): void {
  const opened: JSDOM[] = [];
  const read = (name: string) => {
    const dom = parseXml(parts.get(name));
    opened.push(dom);
    return dom.window.document;
  };
  try {
    if (!parts.has('word/document.xml')) invalid();
    const packageRelationships = relationships(read('_rels/.rels'));
    const main = packageRelationships.filter(
      (item) => item.getAttribute('Type') === `${officeNS}/officeDocument`,
    );
    if (
      main.length !== 1 ||
      !['word/document.xml', '/word/document.xml'].includes(main[0].getAttribute('Target') ?? '') ||
      ![null, 'Internal'].includes(main[0].getAttribute('TargetMode'))
    )
      invalid();

    const types = read('[Content_Types].xml').documentElement;
    if (types.namespaceURI !== typesNS || types.localName !== 'Types') invalid();
    const overrides = new Set<string>();
    const defaults = new Set<string>();
    let mainDeclarations = 0;
    for (const node of Array.from(types.children)) {
      const type = node.getAttribute('ContentType');
      if (node.namespaceURI !== typesNS || node.children.length || !type) invalid();
      if (node.localName === 'Override') {
        const name = node.getAttribute('PartName');
        if (
          !name?.startsWith('/') ||
          !canonicalPart(name.slice(1)) ||
          overrides.has(name.toLowerCase())
        )
          invalid();
        overrides.add(name.toLowerCase());
        if (name === '/word/document.xml') {
          if (type !== mainType) invalid();
          mainDeclarations++;
        } else if (/\.main\+xml$/i.test(type)) invalid();
      } else if (node.localName === 'Default') {
        const extension = node.getAttribute('Extension');
        if (
          !extension ||
          !/^[A-Za-z0-9]+$/.test(extension) ||
          defaults.has(extension.toLowerCase()) ||
          /\.main\+xml$/i.test(type)
        )
          invalid();
        defaults.add(extension.toLowerCase());
      } else invalid();
    }
    if (mainDeclarations !== 1) invalid();

    // Mammoth also follows a styles relationship; native heading reconstruction reads this fixed part.
    if (parts.has('word/_rels/document.xml.rels')) {
      const styles = relationships(read('word/_rels/document.xml.rels')).filter(
        (item) => item.getAttribute('Type') === `${officeNS}/styles`,
      );
      if (
        styles.length > 1 ||
        styles.some(
          (item) =>
            !['styles.xml', '/word/styles.xml'].includes(item.getAttribute('Target') ?? '') ||
            ![null, 'Internal'].includes(item.getAttribute('TargetMode')) ||
            !parts.has('word/styles.xml'),
        )
      )
        invalid();
    }
  } finally {
    for (const dom of opened) dom.window.close();
  }
}
