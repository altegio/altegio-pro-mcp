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
        phone_number: '1234567890',
        user_email: 'john@example.com',
        user_phone: '1234567890',
        is_user_invite: true,
      });

      expect((result.content[0] as any).text).toContain(
        'Successfully created staff'
      );
      expect((result.content[0] as any).text).toContain('John Doe');
      expect(mockClient.createStaff).toHaveBeenCalledWith(456, {
        name: 'John Doe',
        specialization: 'Stylist',
        position_id: 1,
        phone_number: '1234567890',
        user_email: 'john@example.com',
        user_phone: '1234567890',
        is_user_invite: true,
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
        phone_number: null,
        is_paid_staff: false,
      });

      expect(result.isError).toBeUndefined();
      // Both user keys go out as null: the API refuses an unknown user
      // without an invitation, and treats null as "no user account".
      expect(mockClient.createStaff).toHaveBeenCalledWith(456, {
        name: 'Demo Stylist',
        specialization: 'Stylist',
        position_id: null,
        phone_number: null,
        user_email: null,
        user_phone: null,
        is_user_invite: false,
        is_paid_staff: false,
      });
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
        phone_number: '123',
        user_email: 'john@example.com',
        user_phone: '1234567890',
        is_user_invite: true,
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
