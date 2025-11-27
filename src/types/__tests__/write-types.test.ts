import type {
  CreateStaffRequest,
  CreateServiceRequest,
  CreateBookingRequest,
} from '../altegio.types.js';

describe('Write Operation Types', () => {
  it('CreateStaffRequest should have correct structure', () => {
    const request: CreateStaffRequest = {
      name: 'John Doe',
      specialization: 'Stylist',
      position_id: 1,
      phone_number: '1234567890',
      user_email: 'john@example.com',
      user_phone: '1234567890',
      is_user_invite: true,
    };
    expect(request.name).toBe('John Doe');
  });

  it('CreateServiceRequest should have correct structure', () => {
    const request: CreateServiceRequest = {
      title: 'Haircut',
      category_id: 10,
    };
    expect(request.title).toBe('Haircut');
  });

  it('CreateBookingRequest should have correct structure', () => {
    const request: CreateBookingRequest = {
      staff_id: 123,
      services: [{ id: 456 }],
      datetime: '2025-11-01T10:00:00',
      client: { name: 'Jane', phone: '9876543210' },
    };
    expect(request.staff_id).toBe(123);
  });
});
