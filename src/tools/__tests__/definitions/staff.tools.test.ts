import {
  getStaffTool,
  createStaffTool,
  updateStaffTool,
  deleteStaffTool,
} from '../../definitions/staff.tools.js';

describe('Staff Tools', () => {
  const mockClient = {
    isAuthenticated: jest.fn(),
    getStaff: jest.fn(),
    createStaff: jest.fn(),
    updateStaff: jest.fn(),
    deleteStaff: jest.fn(),
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.isAuthenticated.mockReturnValue(true);
  });

  describe('getStaffTool', () => {
    it('requires auth', () => {
      expect(getStaffTool.meta.requiresAuth).toBe(true);
    });

    it('fetches and formats staff list', async () => {
      mockClient.getStaff.mockResolvedValue([
        { id: 1, name: 'John', specialization: 'Stylist' },
      ]);

      const handler = getStaffTool.createHandler(mockClient);
      const result = await handler({ company_id: 123 });

      expect(result.content[0]?.text).toContain('John');
      expect(mockClient.getStaff).toHaveBeenCalledWith(123, {});
    });
  });

  describe('createStaffTool', () => {
    it('creates staff member', async () => {
      mockClient.createStaff.mockResolvedValue({
        id: 99,
        name: 'New Staff',
        specialization: 'Barber',
      });

      const handler = createStaffTool.createHandler(mockClient);
      const result = await handler({
        company_id: 123,
        name: 'New Staff',
        specialization: 'Barber',
        position_id: null,
        phone_number: null,
        user_email: 'staff@test.com',
        user_phone: '+123',
        is_user_invite: false,
      });

      expect(result.content[0]?.text).toContain('Successfully created');
      expect(result.content[0]?.text).toContain('99');
    });
  });

  describe('updateStaffTool', () => {
    it('updates staff member', async () => {
      mockClient.updateStaff.mockResolvedValue({
        id: 1,
        name: 'Updated Name',
        specialization: 'Senior Stylist',
      });

      const handler = updateStaffTool.createHandler(mockClient);
      const result = await handler({
        company_id: 123,
        staff_id: 1,
        name: 'Updated Name',
      });

      expect(result.content[0]?.text).toContain('Successfully updated');
    });
  });

  describe('deleteStaffTool', () => {
    it('deletes staff member', async () => {
      mockClient.deleteStaff.mockResolvedValue(undefined);

      const handler = deleteStaffTool.createHandler(mockClient);
      const result = await handler({ company_id: 123, staff_id: 1 });

      expect(result.content[0]?.text).toContain('Successfully deleted');
      expect(mockClient.deleteStaff).toHaveBeenCalledWith(123, 1);
    });
  });
});
