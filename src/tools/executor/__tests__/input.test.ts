import { AltegioClient } from '../../../providers/altegio-client.js';
import { callOperationTool } from '../../definitions/executor.tools.js';
import { FOLDED_KEY, foldCallArguments, INVALID_KEY } from '../input.js';

describe('api_call_operation argument folding', () => {
  it('folds misplaced containers and top-level parameters into params', () => {
    expect(
      foldCallArguments({
        operationId: 'get_appointment',
        path_params: { location_id: 4564 },
        query: { include_finance_transactions: 1 },
        appointment_id: 7,
      })
    ).toEqual({
      operation_id: 'get_appointment',
      params: {
        location_id: 4564,
        include_finance_transactions: 1,
        appointment_id: 7,
        [FOLDED_KEY]: ['path_params', 'query', 'appointment_id'],
      },
    });
  });

  it('reads params given as a JSON string, and leaves a well-formed call alone', () => {
    expect(
      foldCallArguments({
        operation_id: 'x',
        params: '{"location_id": 1}',
      })
    ).toMatchObject({ params: { location_id: 1, [FOLDED_KEY]: ['params'] } });
    expect(
      foldCallArguments({ operation_id: 'x', params: { location_id: 1 } })
    ).toEqual({ operation_id: 'x', params: { location_id: 1 } });
  });

  it('marks a container that is not an object', () => {
    expect(
      foldCallArguments({ operation_id: 'x', params: 'location 1' })
    ).toMatchObject({ params: { [INVALID_KEY]: ['params'] } });
  });
});

describe('api_call_operation tool', () => {
  const config = { partnerToken: 'test-token', userToken: 'test-user-token' };
  let handler: (args: unknown) => Promise<{
    content: Array<{ text?: string }>;
    isError?: boolean;
    structuredContent?: unknown;
  }>;

  beforeEach(() => {
    global.fetch = jest.fn();
    handler = callOperationTool.createHandler(
      new AltegioClient(config, '/tmp/altegio-executor-input-test')
    ) as typeof handler;
  });

  afterEach(() => jest.restoreAllMocks());

  it('runs a call sent with path_params and says how to send it next time', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { id: 7 }, meta: [] }),
    });
    const result = await handler({
      operation_id: 'get_appointment',
      path_params: { location_id: 4564, appointment_id: 7 },
    });
    expect(result.isError).toBeUndefined();
    expect((global.fetch as jest.Mock).mock.calls[0]?.[0]).toBe(
      'https://api.alteg.io/api/v1/locations/4564/appointments/7'
    );
    expect(result.content[0]?.text).toContain(
      'Read `path_params` as parameters; next time put every path and query parameter in one flat `params` object.'
    );
  });

  it('refuses an unreadable params with an instruction naming params and the parameters', async () => {
    const result = await handler({
      operation_id: 'get_appointment',
      params: 'location 4564',
    });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('one flat `params` object');
    expect(text).toContain('location_id (required), appointment_id (required)');
    expect(text).not.toContain('Unrecognized key');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses a call without an operation id by naming the shape', async () => {
    const result = await handler({ params: { location_id: 4564 } });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('`operation_id` is missing');
  });

  it('names params in the missing-parameter refusal', async () => {
    const result = await handler({
      operation_id: 'get_appointment',
      params: { location_id: 4564 },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      'missing required: appointment_id'
    );
    expect(result.content[0]?.text).toContain('Put them in `params`');
  });
});
