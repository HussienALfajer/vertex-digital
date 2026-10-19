import sharp from 'sharp';

/*
 * Images drawn for `db:seed-local`: SVG rendered by sharp, so no binary sits in the repository.
 * Latin text only, since the fonts on a developer machine vary.
 */

const xml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

async function render(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** A QR-like grid (not a scannable code) for a Sham Cash account. */
export function qrImage(label: string): Promise<Buffer> {
  const cells: string[] = [];
  let seed = [...label].reduce((sum, char) => sum + char.charCodeAt(0), 7);
  for (let row = 0; row < 25; row += 1) {
    for (let column = 0; column < 25; column += 1) {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      const finder =
        (row < 7 || row > 17) && (column < 7 || column > 17) && !(row > 17 && column > 17);
      if (
        finder ? row % 6 === 0 || column % 6 === 0 || (row % 6 > 1 && row % 6 < 5) : seed % 3 === 0
      ) {
        cells.push(`<rect x="${20 + column * 14}" y="${20 + row * 14}" width="14" height="14"/>`);
      }
    }
  }
  return render(
    `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="430"><rect width="390" height="430" fill="#fff"/><g fill="#111">${cells.join('')}</g><text x="195" y="410" font-family="Arial" font-size="18" text-anchor="middle">${xml(label)}</text></svg>`,
  );
}

/** A transfer receipt as a phone screenshot would show it. */
export function receiptImage(input: {
  amount: string;
  reference: string;
  tint: string;
}): Promise<Buffer> {
  return render(
    `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280"><rect width="720" height="1280" fill="#f4f6f8"/><rect x="40" y="120" width="640" height="900" rx="32" fill="#fff"/><circle cx="360" cy="260" r="70" fill="${input.tint}"/><text x="360" y="420" font-family="Arial" font-size="40" text-anchor="middle" fill="#222">Transfer successful</text><text x="360" y="520" font-family="Arial" font-size="64" font-weight="bold" text-anchor="middle" fill="#111">${xml(input.amount)}</text><text x="360" y="640" font-family="Arial" font-size="30" text-anchor="middle" fill="#555">Reference ${xml(input.reference)}</text><text x="360" y="720" font-family="Arial" font-size="30" text-anchor="middle" fill="#555">Vertex Digital</text></svg>`,
  );
}

/** A 1600×800 home banner (2:1, rule MD2). */
export function bannerImage(input: { title: string; from: string; to: string }): Promise<Buffer> {
  return render(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="800"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${input.from}"/><stop offset="1" stop-color="${input.to}"/></linearGradient></defs><rect width="1600" height="800" fill="url(#g)"/><circle cx="1300" cy="200" r="260" fill="#ffffff" fill-opacity="0.08"/><circle cx="1400" cy="650" r="180" fill="#ffffff" fill-opacity="0.06"/><text x="120" y="430" font-family="Arial" font-size="96" font-weight="bold" fill="#fff">${xml(input.title)}</text><text x="120" y="530" font-family="Arial" font-size="44" fill="#fff" fill-opacity="0.85">Vertex Digital</text></svg>`,
  );
}

/** A screenshot-like proof of a delivery or a ticket attachment. */
export function noteImage(input: { title: string; line: string; tint: string }): Promise<Buffer> {
  return render(
    `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#ffffff"/><rect width="900" height="90" fill="${input.tint}"/><text x="40" y="58" font-family="Arial" font-size="34" fill="#fff">${xml(input.title)}</text><text x="40" y="220" font-family="Arial" font-size="36" fill="#222">${xml(input.line)}</text><rect x="40" y="300" width="820" height="18" rx="9" fill="#e3e7eb"/><rect x="40" y="350" width="620" height="18" rx="9" fill="#e3e7eb"/><rect x="40" y="400" width="720" height="18" rx="9" fill="#e3e7eb"/></svg>`,
  );
}
