import { ToolHandlers } from '../handlers.js';
import { AltegioClient } from '../../providers/altegio-client.js';

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
        company_id: 456,
        name: 'John Doe',
        specialization: 'Stylist',
        position_id: 1,
        phone_number: '1234567890',
        user_email: 'john@example.com',
        user_phone: '1234567890',
        is_user_invite: true,
      });

      expect((result.content[0] as any).text).toContain('Successfully created staff');
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

    it('should handle errors', async () => {
      mockClient.createStaff.mockRejectedValue(
        new Error('Not authenticated')
      );

      const result = await handlers.createStaff({
        company_id: 456,
        name: 'John',
        specialization: 'Stylist',
        position_id: 1,
        phone_number: '123',
        user_email: 'john@example.com',
        user_phone: '1234567890',
        is_user_invite: true,
      });

      expect((result.content[0] as any).text).toContain('Failed to create staff');
      expect((result.content[0] as any).text).toContain('Not authenticated');
    });
  });

  describe('updateStaff', () => {
    it('should update staff successfully', async () => {
      const mockStaff = { id: 123, name: 'John Smith' };
      mockClient.updateStaff.mockResolvedValue(mockStaff as any);

      const result = await handlers.updateStaff({
        company_id: 456,
        staff_id: 123,
        name: 'John Smith',
      });

      expect((result.content[0] as any).text).toContain('Successfully updated staff');
      expect(mockClient.updateStaff).toHaveBeenCalledWith(456, 123, {
        name: 'John Smith',
      });
    });
  });

  describe('deleteStaff', () => {
    it('should delete staff successfully', async () => {
      mockClient.deleteStaff.mockResolvedValue(undefined);

      const result = await handlers.deleteStaff({
        company_id: 456,
        staff_id: 123,
      });

      expect((result.content[0] as any).text).toContain('Successfully deleted staff');
      expect(mockClient.deleteStaff).toHaveBeenCalledWith(456, 123);
    });
  });
});
