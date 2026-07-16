/**
 * Minimal safe SQL composition. All values become parameters; fragments nest.
 * Identifiers are never interpolated from user input anywhere in APIck — the
 * content model is data, so table/column names are a fixed, library-owned set.
 */
export class SqlFragment {
  readonly strings: readonly string[];
  readonly values: readonly unknown[];

  constructor(strings: readonly string[], values: readonly unknown[]) {
    this.strings = strings;
    this.values = values;
  }

  compile(): { text: string; values: unknown[] } {
    const values: unknown[] = [];
    let text = '';
    const walk = (frag: SqlFragment): void => {
      for (let i = 0; i < frag.strings.length; i++) {
        text += frag.strings[i];
        if (i < frag.values.length) {
          const v = frag.values[i];
          if (v instanceof SqlFragment) {
            walk(v);
          } else {
            values.push(v);
            text += `$${values.length}`;
          }
        }
      }
    };
    walk(this);
    return { text, values };
  }
}

export function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlFragment {
  return new SqlFragment(strings, values);
}

/** Raw fragment for library-owned constants (never user input). */
sql.raw = (text: string): SqlFragment => new SqlFragment([text], []);

/** Join fragments with a separator, e.g. sql.join(conditions, ' and '). */
sql.join = (frags: SqlFragment[], separator: string): SqlFragment => {
  if (frags.length === 0) return sql.raw('');
  const strings: string[] = [''];
  const values: unknown[] = [];
  for (let i = 0; i < frags.length; i++) {
    values.push(frags[i]);
    strings.push(i < frags.length - 1 ? separator : '');
  }
  return new SqlFragment(strings, values);
};
