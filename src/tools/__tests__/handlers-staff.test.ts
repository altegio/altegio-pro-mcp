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
      deleteStaff: jest.fn(),
    } as any;
    handlers = new ToolHandlers(mockClient);
  });

  describe('createStaff', () => {
    it('should create staff successfully', async () => {
      const mockStaff = { id: 123, name: 'John Doe' };
      mockClient.createStaff.mockResolvedValue(mockStaff as any);

      const result = await handlers.createStaff({
        location_id: 456,
        name: 'John Doe',
        specialization: 'Stylist',
        position_id: 1,
        user_email: 'john@example.com',
        user_phone: '1234567890',
        is_user_invite: true,
        is_paid_staff: true,
        has_timetable_access: true,
      });

      expect((result.content[0] as any).text).toContain(
        'Successfully created staff'
      );
      expect((result.content[0] as any).text).toContain('John Doe');
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
        is_paid_staff: false,
        has_timetable_access: false,
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
      ['is_paid_staff', { has_timetable_access: true }, 'paid staff seat'],
      ['has_timetable_access', { is_paid_staff: true }, 'work schedule'],
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
        is_paid_staff: 'yes',
        has_timetable_access: true,
      });

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('is_paid_staff');
      expect(text).not.toContain('Ask the location owner');
      expect(mockClient.createStaff).not.toHaveBeenCalled();
    });

    it('never sends phone_number: quick-create does not read it', async () => {
      mockClient.createStaff.mockResolvedValue({
        id: 125,
        name: 'Alice',
      } as Awaited<ReturnType<AltegioClient['createStaff']>>);

      await handlers.createStaff({
        location_id: 456,
        name: 'Alice',
        specialization: 'Stylist',
        position_id: null,
        phone_number: '15550001234',
        is_paid_staff: true,
        has_timetable_access: true,
      });

      const [, body] = mockClient.createStaff.mock.calls[0]!;
      expect(body).not.toHaveProperty('phone_number');
    });

    it('should handle errors', async () => {
      mockClient.createStaff.mockRejectedValue(
        new AuthenticationError('Not authenticated. Call altegio_login first.')
      );

      const result = await handlers.createStaff({
        location_id: 456,
        name: 'John',
        specialization: 'Stylist',
        position_id: 1,
        user_email: 'john@example.com',
        user_phone: '1234567890',
        is_user_invite: true,
        is_paid_staff: true,
        has_timetable_access: true,
      });

      expect((result.content[0] as any).text).toContain(
        'Authentication required'
      );
      expect((result.content[0] as any).text).toContain('altegio_login');
    });
  });

  describe('updateStaff', () => {
    it('should update staff successfully', async () => {
      const mockStaff = { id: 123, name: 'John Smith' };
      mockClient.updateStaff.mockResolvedValue(mockStaff as any);

      const result = await handlers.updateStaff({
        location_id: 456,
        team_member_id: 123,
        name: 'John Smith',
      });

      expect((result.content[0] as any).text).toContain(
        'Successfully updated staff'
      );
      expect(mockClient.updateStaff).toHaveBeenCalledWith(456, 123, {
        name: 'John Smith',
      });
    });
  });

  describe('deleteStaff', () => {
    it('should delete staff successfully', async () => {
      mockClient.deleteStaff.mockResolvedValue(undefined);

      const result = await handlers.deleteStaff({
        location_id: 456,
        team_member_id: 123,
      });

      expect((result.content[0] as any).text).toContain(
        'Successfully deleted staff'
      );
      expect(mockClient.deleteStaff).toHaveBeenCalledWith(456, 123);
    });
  });
});
