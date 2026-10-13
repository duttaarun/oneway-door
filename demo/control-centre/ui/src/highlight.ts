// Tiny highlighters for the code panels. Input is escaped first; only our own spans are added.

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const SQL_KW = /\b(ALTER|TABLE|RENAME|COLUMN|TO|TYPE|USING|CREATE|INDEX|ON|ADD|DROP|NOT|NULL|UPDATE|SET|WHERE|BEGIN|COMMIT|DELETE|FROM|bigint|numeric)\b/g;

export function highlightSql(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const e = esc(line);
      if (/^\s*--/.test(line)) return `<span class="cm">${e}</span>`;
      const hot = /RENAME COLUMN|USING \(/.test(line);
      const kw = e.replace(SQL_KW, '<span class="kw">$1</span>');
      return hot ? `<span class="hot">${kw}</span>` : kw;
    })
    .join('\n');
}

export function highlightDiff(diff: string): string {
  return diff
    .split('\n')
    .map((line) => {
      const e = esc(line);
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) return `<span class="cm">${e}</span>`;
      if (line.startsWith('@@')) return `<span class="hunk">${e}</span>`;
      if (line.startsWith('+')) return `<span class="add">${e}</span>`;
      if (line.startsWith('-')) return `<span class="del">${e}</span>`;
      // diff --stat lines: colour the +/- bar.
      return e.replace(/(\++)(-*)$/, '<span class="add">$1</span><span class="del">$2</span>');
    })
    .join('\n');
}
