import {
  formatStaffList,
  formatServicesList,
  formatBookingsList,
  formatCompaniesList,
  formatCategoriesList,
  formatPositionsList,
  formatScheduleList,
} from '../formatters.js';

describe('Formatters', () => {
  describe('formatStaffList', () => {
    it('formats empty list', () => {
      const result = formatStaffList([], 123);
      expect(result).toContain('Found 0 staff members');
    });

    it('formats staff with position', () => {
      const staff = [{
        id: 1,
        name: 'John Doe',
        specialization: 'Stylist',
        rating: 4.5,
        position: { id: 10, title: 'Senior' },
      }];
      const result = formatStaffList(staff, 123);
      expect(result).toContain('John Doe');
      expect(result).toContain('Stylist');
      expect(result).toContain('Senior');
    });
  });

  describe('formatServicesList', () => {
    it('formats services with price and duration', () => {
      const services = [{
        id: 1,
        title: 'Haircut',
        cost: 50,
        duration: 30,
        category_id: 5,
      }];
      const result = formatServicesList(services, 123);
      expect(result).toContain('Haircut');
      expect(result).toContain('50');
      expect(result).toContain('30 min');
    });
  });

  describe('formatCompaniesList', () => {
    it('formats companies list', () => {
      const companies = [{
        id: 1,
        title: 'Salon ABC',
        public_title: 'Salon ABC',
        address: '123 Main St',
        phone: '+123456789',
        short_descr: '',
        country_id: 1,
        country: 'US',
        city_id: 1,
        city: 'New York',
        active: 1,
        phones: ['+123456789'],
        email: 'salon@example.com',
        timezone: -5,
        timezone_name: 'America/New_York',
        schedule: '',
        currency_short_title: 'USD',
        business_type_id: 1,
      }];
      const result = formatCompaniesList(companies, false);
      expect(result).toContain('Salon ABC');
      expect(result).toContain('123 Main St');
    });
  });

  describe('formatBookingsList', () => {
    it('formats bookings with client and services', () => {
      const bookings = [{
        id: 1,
        company_id: 123,
        staff_id: 1,
        datetime: '2025-01-15 10:00:00',
        date: '2025-01-15',
        duration: 60,
        client: { id: 1, name: 'Jane', phone: '+123' },
        staff: { id: 1, name: 'John' },
        services: [{ id: 1, title: 'Haircut', cost: 50 }],
        status: 'confirmed',
      }];
      const result = formatBookingsList(bookings, 123);
      expect(result).toContain('Jane');
      expect(result).toContain('Haircut');
      expect(result).toContain('confirmed');
    });
  });

  describe('formatCategoriesList', () => {
    it('formats categories with services', () => {
      const categories = [{
        id: 1,
        title: 'Hair Services',
        services: [
          { id: 1, title: 'Haircut', cost: 50 },
          { id: 2, title: 'Coloring', cost: 100 }
        ],
      }];
      const result = formatCategoriesList(categories, 123);
      expect(result).toContain('Hair Services');
      expect(result).toContain('Services count: 2');
    });

    it('handles empty list', () => {
      const result = formatCategoriesList([], 123);
      expect(result).toContain('Found 0 service categories');
    });
  });

  describe('formatPositionsList', () => {
    it('formats positions', () => {
      const positions = [{ id: 1, title: 'Manager' }];
      const result = formatPositionsList(positions);
      expect(result).toContain('Manager');
      expect(result).toContain('ID: 1');
    });

    it('handles empty list', () => {
      const result = formatPositionsList([]);
      expect(result).toContain('No positions found');
    });
  });

  describe('formatScheduleList', () => {
    it('formats schedule entries', () => {
      const schedule = [{
        date: '2025-01-15',
        time: '09:00',
        seance_length: 60,
        datetime: '2025-01-15 09:00:00',
      }];
      const result = formatScheduleList(schedule, 1);
      expect(result).toContain('2025-01-15');
      expect(result).toContain('09:00');
      expect(result).toContain('60 min');
    });
  });
});
