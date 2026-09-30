function normalizedComment(value) {
  return value.replace(/^[!/]\s?/u, '').split(/\r?\n/u).map((line) => line.replace(/^\s*\*\s?/u, '').trim()).join('\n');
}

export function isLintDirective(value) {
  const text = normalizedComment(value);

  return /^(?:eslint|oxlint)-(?:disable-next-line|disable-line|disable|enable)(?=\s|$)/u.test(text)
    || /^(?:eslint|global|globals|exported)\s+\S/u.test(text);
}

function headerPrefix(source) {
  return source.match(/^\uFEFF?(?:#!(?!\[)[^\r\n]*(?:\r?\n|$))?/u)[0].length;
}

function isLicenseHeader(header) {
  const text = header.map((comment) => normalizedComment(comment.value)).join('\n');

  return /^(?:Copyright\b|SPDX-License-Identifier:|SPDX-FileCopyrightText:|@license\b|@preserve\b|Licensed under\b)/imu.test(text);
}

export function licenseHeaderComments(source, comments) {
  const headers = [];
  let cursor = headerPrefix(source);

  for (const comment of comments) {
    const gap = source.slice(cursor, comment.range[0]);

    if (gap.trim()) break;
    const previous = headers.at(-1);
    const joinsLineHeader = comment.type === 'Line' && previous?.at(-1).type === 'Line' && /^[\t \r]*\n[\t ]*$/u.test(gap);

    if (joinsLineHeader) previous.push(comment);
    else headers.push([comment]);
    cursor = comment.range[1];
  }

  return new Set(headers.filter(isLicenseHeader).flat());
}
