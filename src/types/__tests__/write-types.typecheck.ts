/** Compile-time request examples, checked by tsconfig.test.json, not Jest. */
import type {
  CreateStaffRequest,
  CreateServiceRequest,
  CreateBookingRequest,
} from '../altegio.types.js';

export const staff: CreateStaffRequest = {
  name: 'John Doe',
  specialization: 'Stylist',
  position_id: 1,
  user_email: 'john@example.com',
  user_phone: '1234567890',
  is_user_invite: true,
  is_paid_staff: true,
  has_timetable_access: true,
};

export const service: CreateServiceRequest = {
  title: 'Haircut',
  category_id: 10,
};

export const booking: CreateBookingRequest = {
  staff_id: 123,
  services: [{ id: 456 }],
  datetime: '2025-11-01T10:00:00',
  client: { name: 'Jane', phone: '9876543210' },
};
