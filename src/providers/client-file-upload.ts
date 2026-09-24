/** Validation at the hosted MCP boundary, before constructing multipart data. */
export const CLIENT_FILE_MAX_BYTES = 12 * 1024 * 1024;
export const CLIENT_FILE_MAX_BASE64_CHARS =
  4 * Math.ceil((CLIENT_FILE_MAX_BYTES - 1) / 3);

const MIME_BY_EXTENSION: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
};

export function prepareClientFile(
  filename: string,
  base64: string
): {
  bytes: Buffer;
  mime: string;
} {
  // A filename is metadata supplied to the upstream multipart parser, never a path.
  if (
    filename.length < 1 ||
    filename.length > 255 ||
    filename !== filename.trim() ||
    /[\\/\u0000-\u001f\u007f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(
      filename
    )
  ) {
    throw new Error(
      'Use a filename of 1–255 characters without paths or control characters.'
    );
  }
  // A bare "pdf" or ".pdf" has no name before its extension.
  const dot = filename.lastIndexOf('.');
  const extension = dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
  const mime = MIME_BY_EXTENSION[extension];
  if (!mime) {
    throw new Error(
      'Unsupported client-file extension. Use jpeg, jpg, png, gif, doc, docx, pdf, xls, xlsx, or txt.'
    );
  }
  if (
    base64.length === 0 ||
    base64.length > CLIENT_FILE_MAX_BASE64_CHARS ||
    base64.length % 4 !== 0
  ) {
    throw new Error(
      'file_base64 must be canonical base64 for a nonempty file smaller than 12 MiB.'
    );
  }
  const bytes = Buffer.from(base64, 'base64');
  if (
    bytes.length === 0 ||
    bytes.length >= CLIENT_FILE_MAX_BYTES ||
    bytes.toString('base64') !== base64
  ) {
    throw new Error(
      'file_base64 must be canonical base64 for a nonempty file smaller than 12 MiB.'
    );
  }
  return { bytes, mime };
}
