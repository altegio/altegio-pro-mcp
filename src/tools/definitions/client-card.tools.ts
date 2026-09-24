/**
 * `[Clients]` client-card evidence and attachments: membership purchases,
 * comments and files.
 *
 * These tools compose small documented V1 reads that the segmentation pack in
 * `./clients.tools.ts` does not cover. Every name, parameter and result field
 * uses canonical vocabulary; the V1 wire fields (`abonement`, goods
 * transactions, `date_create`, `full_link`) stop in this module. Comment text,
 * filenames and membership labels are written by the location's clients and
 * team, so they are sanitized in structured content and fenced in the text.
 */
import { z } from 'zod';
import { defineTool } from '../factory.js';
import {
  sanitizeUntrustedDeep,
  withUntrustedBlock,
  type UntrustedField,
} from '../tool-result.js';
import { ExecutorRefusalError } from '../../utils/errors.js';
import { CLIENT_FILE_MAX_BASE64_CHARS } from '../../providers/client-file-upload.js';
import type { AltegioClient } from '../../providers/altegio-client.js';
import { probe, type ProbeStatus } from '../../api/v1/probe.js';
import {
  asFiniteNumber,
  asInteger,
  asPositiveId,
  asRecord,
  asRecords,
  asText,
} from '../../api/v1/wire-values.js';

/** Memberships inspected per call; each costs up to three reads. */
const MEMBERSHIP_LIMIT = 20;
/** Comments or files projected per call. */
const LIST_LIMIT = 50;
/** V1 inventory transaction type of a sale. */
const SALE_TRANSACTION_TYPE = 1;

const locationId = z
  .number()
  .int()
  .positive()
  .describe(
    'Location whose client card to work with. Call list_locations when the id is unknown.'
  );
const clientId = z
  .number()
  .int()
  .positive()
  .describe('Client id, from clients_search or clients_lookup.');

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

const objectSchema = (properties: Record<string, object>) => ({
  type: 'object' as const,
  properties,
  required: Object.keys(properties),
});
const int = { type: 'integer' };
const nullableInt = { type: ['integer', 'null'] };
const nullableStr = { type: ['string', 'null'] };
const evidenceGaps = ['forbidden', 'not_found', 'unavailable'];

const fileListOutput = objectSchema({
  location_id: int,
  client_id: int,
  total_count: int,
  returned: int,
  complete: { type: 'boolean' },
  files: {
    type: 'array',
    items: objectSchema({
      id: nullableInt,
      name: nullableStr,
      created_at: nullableStr,
      size_label: {
        type: ['string', 'null'],
        description: 'Human-readable size from the source, e.g. 96.65 KB.',
      },
      download_url: nullableStr,
    }),
  },
});

// ========== clients_get_membership_purchases ==========

type SaleTransactionEvidence =
  'verified' | 'not_linked' | 'mismatch' | Exclude<ProbeStatus, 'ok'>;
type SaleDocumentEvidence =
  'readable' | 'not_linked' | 'not_checked' | Exclude<ProbeStatus, 'ok'>;

interface MembershipPurchase {
  membership_id: number;
  membership_number: string | null;
  membership_type_id: number | null;
  membership_type_title: string | null;
  /** When the membership was created — not a sale date. */
  created_at: string | null;
  identity_verified: true;
  sale_transaction: SaleTransactionEvidence;
  sale_date: string | null;
  /** Unit price recorded on the sale transaction — not a proven paid amount. */
  recorded_unit_price: number | null;
  sale_document: SaleDocumentEvidence;
  sale_document_id: number | null;
  paid_amount: null;
}

/**
 * Follow membership → sale transaction → sale document. The sale is accepted
 * only when it is a live sale of exactly one unit of this membership type.
 */
async function saleEvidence(
  client: AltegioClient,
  locationIdValue: number,
  membership: Record<string, unknown>,
  typeId: number | null
): Promise<
  Pick<
    MembershipPurchase,
    | 'sale_transaction'
    | 'sale_date'
    | 'recorded_unit_price'
    | 'sale_document'
    | 'sale_document_id'
  >
> {
  const none = {
    sale_date: null,
    recorded_unit_price: null,
    sale_document: 'not_checked' as const,
    sale_document_id: null,
  };
  const transactionId = asPositiveId(membership.goods_transaction_id);
  if (transactionId === null)
    return { sale_transaction: 'not_linked', ...none };

  const read = await probe(async () =>
    asRecord(
      (
        await client.request<unknown>(
          'GET',
          `/storage_operations/goods_transactions/${locationIdValue}/${transactionId}`
        )
      ).data
    )
  );
  if (read.status !== 'ok') return { sale_transaction: read.status, ...none };

  const sale = read.data;
  const product = asRecord(sale.good);
  const linkedTypeId = Number(product.loyalty_abonement_type_id);
  if (
    asInteger(sale.id) !== transactionId ||
    asInteger(sale.type_id) !== SALE_TRANSACTION_TYPE ||
    sale.deleted === true ||
    asFiniteNumber(sale.amount) !== -1 ||
    typeId === null ||
    linkedTypeId !== typeId
  )
    return { sale_transaction: 'mismatch', ...none };

  const unitPrice = asFiniteNumber(sale.cost_per_unit);
  const documentId = asPositiveId(sale.document_id);
  const document =
    documentId === null
      ? ({ status: 'not_linked' } as const)
      : await probe(() =>
          client.request<unknown>(
            'GET',
            `/company/${locationIdValue}/sale/${documentId}`
          )
        );
  return {
    sale_transaction: 'verified',
    sale_date: asText(sale.create_date),
    recorded_unit_price:
      unitPrice !== null && unitPrice >= 0 ? unitPrice : null,
    sale_document: document.status === 'ok' ? 'readable' : document.status,
    sale_document_id: documentId,
  };
}

export const clientsGetMembershipPurchasesTool = defineTool({
  name: 'clients_get_membership_purchases',
  category: 'Clients',
  description: `[Clients] Inspect up to ${MEMBERSHIP_LIMIT} memberships of one client. Memberships are found by the client’s current phone, and each is verified against the client-specific membership history before it is reported. Where permitted, follows the linked sale transaction and sale document. A membership creation date is not a sale date, the current membership type price is not a purchase price, and the recorded unit price is not a proven paid amount; paid_amount stays null because a sale document does not attribute payment to one item. Returns explicit evidence status per membership and may miss memberships sold under an earlier phone.`,
  annotations: { title: 'Client membership purchases', ...READ_ONLY },
  input: z.object({ location_id: locationId, client_id: clientId }),
  outputSchema: objectSchema({
    location_id: int,
    client_id: int,
    candidate_count: int,
    inspected_count: int,
    unverified_candidate_count: int,
    complete_candidate_scan: { type: 'boolean' },
    historical_completeness: { type: 'string' },
    memberships: {
      type: 'array',
      items: objectSchema({
        membership_id: int,
        membership_number: nullableStr,
        membership_type_id: nullableInt,
        membership_type_title: nullableStr,
        created_at: nullableStr,
        identity_verified: { type: 'boolean' },
        sale_transaction: {
          type: 'string',
          enum: ['verified', 'not_linked', 'mismatch', ...evidenceGaps],
        },
        sale_date: nullableStr,
        recorded_unit_price: { type: ['number', 'null'] },
        sale_document: {
          type: 'string',
          enum: ['readable', 'not_linked', 'not_checked', ...evidenceGaps],
        },
        sale_document_id: nullableInt,
        paid_amount: { type: 'null' },
      }),
    },
  }),
  handler: async ({ input, client }) => {
    const card = asRecord(
      (
        await client.request<unknown>(
          'GET',
          `/client/${input.location_id}/${input.client_id}`
        )
      ).data
    );
    const phone = asText(card.phone);
    if (!phone)
      throw new ExecutorRefusalError(
        'This client card has no phone, and memberships can only be looked up by phone. Membership purchases cannot be verified for this client.'
      );
    const candidates = asRecords(
      (
        await client.request<unknown>(
          'GET',
          '/loyalty/abonements',
          { company_id: input.location_id, phone },
          input.location_id
        )
      ).data
    );
    const inspected = candidates.slice(0, MEMBERSHIP_LIMIT);

    const memberships: MembershipPurchase[] = [];
    let unverified = 0;
    for (const candidate of inspected) {
      const membershipId = asPositiveId(candidate.id);
      if (membershipId === null) {
        unverified += 1;
        continue;
      }
      // The history route answers 404 when the membership belongs to another
      // client with the same phone; only a 200 proves it is this client's.
      const owner = await probe(() =>
        client.request<unknown>(
          'GET',
          `/company/${input.location_id}/client/${input.client_id}/loyalty/abonements/${membershipId}/history`
        )
      );
      if (owner.status !== 'ok') {
        if (owner.status !== 'not_found') unverified += 1;
        continue;
      }
      const type = asRecord(candidate.type);
      const typeId = asPositiveId(type.id);
      memberships.push({
        membership_id: membershipId,
        membership_number: asText(candidate.number),
        membership_type_id: typeId,
        membership_type_title: asText(type.title),
        created_at: asText(candidate.created_date),
        identity_verified: true,
        ...(await saleEvidence(client, input.location_id, candidate, typeId)),
        paid_amount: null,
      });
    }

    const summary = [
      `Client ${input.client_id}: ${candidates.length} membership candidate(s) found by the current phone; inspected ${inspected.length}, verified ${memberships.length} as this client’s, ${unverified} could not be checked.`,
      ...memberships.map(
        (m) =>
          `Membership ${m.membership_id}: sale transaction ${m.sale_transaction}, sale document ${m.sale_document}${m.sale_date ? `, sold ${m.sale_date}` : ''}${m.recorded_unit_price !== null ? `, recorded unit price ${m.recorded_unit_price}` : ''}.`
      ),
      'Paid amounts stay unknown: a sale document does not attribute payment to the membership item.',
    ].join('\n');
    // One field per value: each is sanitized on its own, so a forged turn
    // marker at the start of a title is redacted rather than carried inline.
    const labels: UntrustedField[] = memberships.flatMap((m) => [
      {
        label: `membership ${m.membership_id} number`,
        value: m.membership_number,
      },
      {
        label: `membership ${m.membership_id} type`,
        value: m.membership_type_title,
      },
    ]);
    return {
      text: withUntrustedBlock(summary, labels),
      structuredContent: sanitizeUntrustedDeep({
        location_id: input.location_id,
        client_id: input.client_id,
        candidate_count: candidates.length,
        inspected_count: inspected.length,
        unverified_candidate_count: unverified,
        complete_candidate_scan: candidates.length <= MEMBERSHIP_LIMIT,
        historical_completeness:
          'unknown; the lookup uses the current client phone and can miss older, transferred or deleted memberships',
        memberships,
      }),
    };
  },
});

// ========== clients_list_comments ==========

export const clientsListCommentsTool = defineTool({
  name: 'clients_list_comments',
  category: 'Clients',
  description: `[Clients] List up to ${LIST_LIMIT} comments on a client card, including the history entries that file uploads create. Comment text is written by clients or team members; a URL in it is only text. Requires client and comment-list rights.`,
  annotations: { title: 'List client comments', ...READ_ONLY },
  input: z.object({ location_id: locationId, client_id: clientId }),
  outputSchema: objectSchema({
    location_id: int,
    client_id: int,
    total_count: int,
    returned: int,
    complete: { type: 'boolean' },
    comments: {
      type: 'array',
      items: objectSchema({
        id: nullableInt,
        type: nullableStr,
        created_at: nullableStr,
        text: nullableStr,
        file_count: int,
      }),
    },
  }),
  handler: async ({ input, client }) => {
    const all = asRecords(
      (
        await client.request<unknown>(
          'GET',
          `/company/${input.location_id}/clients/${input.client_id}/comments`
        )
      ).data
    );
    const comments = all.slice(0, LIST_LIMIT).map((entry) => ({
      id: asInteger(entry.id),
      type: entry.type === 'default' ? 'text' : asText(entry.type),
      created_at: asText(entry.create_date),
      text: asText(entry.text),
      file_count: asRecords(entry.files).length,
    }));
    return {
      text: withUntrustedBlock(
        `${all.length} comment(s) on client ${input.client_id}; returned ${comments.length}.`,
        comments.map((c) => ({
          label: `comment ${c.id ?? '?'} (${c.created_at ?? 'no date'})`,
          value: c.text,
        }))
      ),
      structuredContent: sanitizeUntrustedDeep({
        location_id: input.location_id,
        client_id: input.client_id,
        total_count: all.length,
        returned: comments.length,
        complete: all.length <= LIST_LIMIT,
        comments,
      }),
    };
  },
});

// ========== clients_add_comment ==========

export const clientsAddCommentTool = defineTool({
  name: 'clients_add_comment',
  category: 'Clients',
  description:
    '[Clients] Add one text comment to a client card. A form URL stays text; use clients_upload_file to attach a completed file.',
  annotations: {
    title: 'Add client comment',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    client_id: clientId,
    text: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .describe('Comment text, 1–255 characters.'),
  }),
  outputSchema: objectSchema({
    location_id: int,
    client_id: int,
    comment_id: nullableInt,
    created_at: nullableStr,
  }),
  handler: async ({ input, client }) => {
    const created = asRecord(
      await client.postJson(
        `/company/${input.location_id}/clients/${input.client_id}/comments`,
        { text: input.text }
      )
    );
    const commentId = asInteger(created.id);
    return {
      text: `Added comment ${commentId ?? 'without a reported id'} to client ${input.client_id}.`,
      structuredContent: {
        location_id: input.location_id,
        client_id: input.client_id,
        comment_id: commentId,
        created_at: asText(created.create_date),
      },
    };
  },
});

// ========== client files ==========

/** Only the documented download route on an Altegio host is passed through. */
function clientFileDownloadUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (
      url.protocol === 'https:' &&
      ['app.alteg.io', 'yclients.com'].includes(url.hostname) &&
      /^\/client_files\/download\/\d+\/\d+\/?$/.test(url.pathname) &&
      !url.search &&
      !url.hash
    )
      return url.toString();
  } catch {
    /* An invalid URL is omitted. */
  }
  return null;
}

/** One file-list page as the model sees it, from list and upload alike. */
function fileListResult(
  input: { location_id: number; client_id: number },
  entries: Record<string, unknown>[],
  lead: string
) {
  const files = entries.slice(0, LIST_LIMIT).map((entry) => ({
    id: asInteger(entry.id),
    name: asText(entry.name),
    created_at: asText(entry.date_create),
    size_label: asText(entry.size),
    download_url: clientFileDownloadUrl(entry.full_link),
  }));
  return {
    text: withUntrustedBlock(
      `${lead} Client ${input.client_id} has ${entries.length} file(s); returned ${files.length}.`,
      files.flatMap((f) => [
        { label: `file ${f.id ?? '?'}`, value: f.name },
        { label: `file ${f.id ?? '?'} link`, value: f.download_url },
      ])
    ),
    structuredContent: sanitizeUntrustedDeep({
      location_id: input.location_id,
      client_id: input.client_id,
      total_count: entries.length,
      returned: files.length,
      complete: entries.length <= LIST_LIMIT,
      files,
    }),
  };
}

export const clientsListFilesTool = defineTool({
  name: 'clients_list_files',
  category: 'Clients',
  description: `[Clients] List up to ${LIST_LIMIT} files attached to a client card, with download links. A comment containing a form URL is not an attached file. Requires client and file-list rights.`,
  annotations: { title: 'List client files', ...READ_ONLY },
  input: z.object({ location_id: locationId, client_id: clientId }),
  outputSchema: fileListOutput,
  handler: async ({ input, client }) =>
    fileListResult(
      input,
      asRecords(
        (
          await client.request<unknown>(
            'GET',
            `/company/${input.location_id}/clients/files/${input.client_id}`
          )
        ).data
      ),
      'Listed client files.'
    ),
});

export const clientsUploadFileTool = defineTool({
  name: 'clients_upload_file',
  category: 'Clients',
  description:
    '[Clients] Attach one completed file to a client card. Supply the actual file bytes as raw base64, not a URL or data URI. Allowed extensions: jpeg, jpg, png, gif, doc, docx, pdf, xls, xlsx, txt; nonempty file strictly below 12 MiB. Requires client and file-upload rights. Returns the client’s file list after the upload; the upload also adds a file entry to the card’s comments.',
  annotations: {
    title: 'Upload client file',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    client_id: clientId,
    filename: z
      .string()
      .min(1)
      .max(255)
      .describe(
        'File name with an allowed extension, for example intake.pdf; no path.'
      ),
    file_base64: z
      .string()
      .min(1)
      .max(CLIENT_FILE_MAX_BASE64_CHARS)
      .describe(
        'Raw RFC 4648 base64 of the completed file bytes; no data URI prefix.'
      ),
  }),
  outputSchema: fileListOutput,
  handler: async ({ input, client }) =>
    fileListResult(
      input,
      asRecords(
        await client.uploadClientFile(
          input.location_id,
          input.client_id,
          input.filename,
          input.file_base64
        )
      ),
      'Uploaded one file.'
    ),
});
