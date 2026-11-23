import { ToolHandlers } from '../handlers.js';
import { AltegioClient } from '../../providers/altegio-client.js';
import { AuthenticationError } from '../../utils/errors.js';

jest.mock('../../providers/altegio-client.js');

describe('ToolHandlers - Staff CRUD', () => {
  let handlers: ToolHandlers;
  let mockClient: jest.Mocked<AltegioClient>;

  beforeEach(() => {
    mockClient = {
      createStaff: jest.fn(),
      updateStaff: jest.fn(),
      getStaff: jest.fn(),
      deleteStaff: jest.fn(),
    } as unknown as jest.Mocked<AltegioClient>;
    handlers = new ToolHandlers(mockClient);
  });

  describe('createStaff', () => {
    it('should create staff successfully', async () => {
      const mockStaff = { id: 123, name: 'John Doe' };
      mockClient.createStaff.mockResolvedValue(
        mockStaff as Awaited<ReturnType<AltegioClient['createStaff']>>
      );

      const result = await handlers.createStaff({
        location_id: 456,
        name: 'John Doe',
        specialization: 'Stylist',
        position_id: 1,
        user_email: 'john@example.com',
        user_phone: '1234567890',
        invite_user: true,
        has_paid_seat: true,
        has_schedule_access: true,
      });

      expect(result.content[0]?.text).toContain('Created team member');
      expect(result.content[0]?.text).toContain('John Doe');
      expect(mockClient.createStaff).toHaveBeenCalledWith(456, {
        name: 'John Doe',
        specialization: 'Stylist',
        position_id: 1,
        user_email: 'john@example.com',
        user_phone: '1234567890',
        is_user_invite: true,
        is_paid_staff: true,
        has_timetable_access: true,
      });
    });

    it('creates a team member without a user account when no user is named', async () => {
      mockClient.createStaff.mockResolvedValue({
        id: 124,
        name: 'Demo Stylist',
      } as Awaited<ReturnType<AltegioClient['createStaff']>>);

      const result = await handlers.createStaff({
        location_id: 456,
        name: 'Demo Stylist',
        specialization: 'Stylist',
        position_id: null,
        has_paid_seat: false,
        has_schedule_access: false,
      });

      expect(result.isError).toBeUndefined();
      // Both user keys go out as null: the API refuses an unknown user
      // without an invitation, and treats null as "no user account".
      expect(mockClient.createStaff).toHaveBeenCalledWith(456, {
        name: 'Demo Stylist',
        specialization: 'Stylist',
        position_id: null,
        user_email: null,
        user_phone: null,
        is_user_invite: false,
        is_paid_staff: false,
        has_timetable_access: false,
      });
    });

    it.each([
      ['has_paid_seat', { has_schedule_access: true }, 'paid seat'],
      ['has_schedule_access', { has_paid_seat: true }, 'work schedule'],
    ])(
      'refuses a missing %s and tells the model to ask the owner',
      async (field, answered, topic) => {
        const result = await handlers.createStaff({
          location_id: 456,
          name: 'Alice',
          specialization: 'Stylist',
          position_id: null,
          ...answered,
        });

        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain(`${field}: Missing. Ask the location owner`);
        expect(text).toContain(topic);
        expect(mockClient.createStaff).not.toHaveBeenCalled();
      }
    );

    it('keeps the type error for a value that is not a boolean', async () => {
      const result = await handlers.createStaff({
        location_id: 456,
        name: 'Alice',
        specialization: 'Stylist',
        position_id: null,
        has_paid_seat: 'yes',
        has_schedule_access: true,
      });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('has_paid_seat');
      expect(text).not.toContain('Ask the location owner');
      expect(mockClient.createStaff).not.toHaveBeenCalled();
    });

    it('rejects obsolete phone_number instead of pretending to store it', async () => {
      mockClient.createStaff.mockResolvedValue({
        id: 125,
        name: 'Alice',
      } as Awaited<ReturnType<AltegioClient['createStaff']>>);

      const result = await handlers.createStaff({
        location_id: 456,
        name: 'Alice',
        specialization: 'Stylist',
        position_id: null,
        phone_number: '15550001234',
        has_paid_seat: true,
        has_schedule_access: true,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('phone_number');
      expect(mockClient.createStaff).not.toHaveBeenCalled();
    });

    it('should handle errors', async () => {
      mockClient.createStaff.mockRejectedValue(
        new AuthenticationError('Not authenticated. Call auth_login first.')
      );

      const result = await handlers.createStaff({
        location_id: 456,
        name: 'John',
        specialization: 'Stylist',
        position_id: 1,
        user_email: 'john@example.com',
        user_phone: '1234567890',
        invite_user: true,
        has_paid_seat: true,
        has_schedule_access: true,
      });

      expect(result.content[0]?.text).toContain('Authentication required');
      expect(result.content[0]?.text).toContain('auth_login');
    });
  });

  describe('updateStaff', () => {
    it('should update staff successfully', async () => {
      const mockStaff = { id: 123, name: 'John Smith' };
      mockClient.updateStaff.mockResolvedValue(
        mockStaff as Awaited<ReturnType<AltegioClient['updateStaff']>>
      );

      const result = await handlers.updateStaff({
        location_id: 456,
        team_member_id: 123,
        name: 'John Smith',
      });

      expect(result.content[0]?.text).toContain('Updated team member');
      expect(mockClient.updateStaff).toHaveBeenCalledWith(456, 123, {
        name: 'John Smith',
      });
      expect(mockClient.getStaff).not.toHaveBeenCalled();
    });

    it('sends the stored name on a partial update (regression: 422 without name)', async () => {
      mockClient.getStaff.mockResolvedValue([
        { id: 122, name: 'Other' },
        { id: 123, name: 'John Smith', specialization: 'Stylist' },
      ] as Awaited<ReturnType<AltegioClient['getStaff']>>);
      mockClient.updateStaff.mockResolvedValue({
        id: 123,
        name: 'John Smith',
      } as Awaited<ReturnType<AltegioClient['updateStaff']>>);

      const result = await handlers.updateStaff({
        location_id: 456,
        team_member_id: 123,
        external_id: 'ext-9',
        hidden_from_online_booking: true,
      });

      expect(result.isError).toBeUndefined();
      expect(mockClient.updateStaff).toHaveBeenCalledWith(456, 123, {
        name: 'John Smith',
        api_id: 'ext-9',
        hidden: 1,
      });
    });

    it('refuses a partial update of a team member that is not at the location', async () => {
      mockClient.getStaff.mockResolvedValue([
        { id: 122, name: 'Other' },
      ] as Awaited<ReturnType<AltegioClient['getStaff']>>);

      const result = await handlers.updateStaff({
        location_id: 456,
        team_member_id: 123,
        dismissed: true,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('not found at location 456');
      expect(mockClient.updateStaff).not.toHaveBeenCalled();
    });
  });

  describe('createStaff read-back', () => {
    it('reports a paid seat that Altegio did not apply (regression)', async () => {
      mockClient.createStaff.mockResolvedValue({
        id: 3124597,
        name: 'Ann',
        is_paid_staff: false,
        has_access_timetable: true,
      } as Awaited<ReturnType<AltegioClient['createStaff']>>);

      const result = await handlers.createStaff({
        location_id: 456,
        name: 'Ann',
        specialization: 'Stylist',
        position_id: null,
        has_paid_seat: true,
        has_schedule_access: true,
      });

      expect(result.content[0]?.text).toContain(
        'has_paid_seat was not applied'
      );
      expect(result.structuredContent).toMatchObject({
        id: 3124597,
        has_paid_seat: false,
        has_schedule_access: true,
      });
    });

    it('adds no note when the stored flags match the request', async () => {
      mockClient.createStaff.mockResolvedValue({
        id: 7,
        name: 'Ann',
        is_paid_staff: true,
        has_access_timetable: true,
      } as Awaited<ReturnType<AltegioClient['createStaff']>>);

      const result = await handlers.createStaff({
        location_id: 456,
        name: 'Ann',
        specialization: 'Stylist',
        position_id: null,
        has_paid_seat: true,
        has_schedule_access: true,
      });

      expect(result.content[0]?.text).not.toContain('not applied');
      expect(result.structuredContent).not.toHaveProperty('notes');
    });
  });

  describe('deleteStaff', () => {
    it('should delete staff successfully', async () => {
      mockClient.deleteStaff.mockResolvedValue(undefined);

      const result = await handlers.deleteStaff({
        location_id: 456,
        team_member_id: 123,
      });

      expect(result.content[0]?.text).toContain('Deleted team member');
      expect(mockClient.deleteStaff).toHaveBeenCalledWith(456, 123);
    });
  });
});
