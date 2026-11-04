import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LegacyAnalyticsParseError,
  parseCashFlowBreakdownHtml,
  parseSearchEnvelope,
} from '../legacy-analytics-parser.js';
import {
  createToolCallObservation,
  runObservingToolCall,
} from '../../../utils/tool-call-observation.js';

const html = readFileSync(
  join(__dirname, 'fixtures/legacy-analytics/cash-flow-en.html'),
  'utf8'
);

it.each([
  ['not JSON PRIVATE', 'invalid_json_envelope'],
  ['null', 'empty_envelope'],
  [JSON.stringify({ success: false, message: 'PRIVATE' }), 'filters_rejected'],
  [
    JSON.stringify({ success: true, content: 'PRIVATE', count: 'bad' }),
    'invalid_count',
  ],
  [JSON.stringify({ success: true, count: 1 }), 'missing_html'],
])('records a fixed reason for an invalid search envelope', (body, reason) => {
  const observation = createToolCallObservation();
  expect(() =>
    runObservingToolCall(observation, () =>
      parseSearchEnvelope(body, 'cash-flow breakdown')
    )
  ).toThrow(LegacyAnalyticsParseError);
  expect(observation).toEqual({
    upstreamResponses: 0,
    cashFlowParseReason: reason,
  });
  expect(JSON.stringify(observation)).not.toContain('PRIVATE');
});

it.each([
  ['<p>PRIVATE report</p>', 'headers_missing'],
  [html.replace('report-all-cell', 'PRIVATE'), 'total_missing'],
  [html.replace('colspan="3"', 'colspan="4"'), 'account_type_columns'],
])('records the actual failed structural parser branch', (source, reason) => {
  const observation = createToolCallObservation();
  expect(() =>
    runObservingToolCall(observation, () =>
      parseCashFlowBreakdownHtml({
        html: source,
        currency: 'USD',
        accountType: 'all',
      })
    )
  ).toThrow(LegacyAnalyticsParseError);
  expect(observation.cashFlowParseReason).toBe(reason);
  expect(JSON.stringify(observation)).not.toContain('PRIVATE');
});

it('leaves successful reports and other parsers without a cash-flow failure', () => {
  const observation = createToolCallObservation();
  runObservingToolCall(observation, () => {
    parseCashFlowBreakdownHtml({ html, currency: 'USD', accountType: 'all' });
    new LegacyAnalyticsParseError('other report', 'PRIVATE');
  });
  expect(observation).toEqual({ upstreamResponses: 0 });
});

it('maps unknown details, including inherited object properties, to a fixed fallback', () => {
  for (const detail of ['PRIVATE', 'toString', '__proto__']) {
    const observation = createToolCallObservation();
    runObservingToolCall(
      observation,
      () => new LegacyAnalyticsParseError('cash-flow breakdown', detail)
    );
    expect(observation.cashFlowParseReason).toBe('other');
  }
});
