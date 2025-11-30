import type {
  AltegioStaff,
  AltegioService,
  AltegioBooking,
  AltegioCompany,
  AltegioServiceCategory,
  AltegioPosition,
  AltegioScheduleEntry,
} from '../types/altegio.types.js';

export function formatStaffList(staff: AltegioStaff[], companyId: number): string {
  const summary = `Found ${staff.length} staff ${staff.length === 1 ? 'member' : 'members'} for company ${companyId}:\n\n`;

  if (staff.length === 0) return summary;

  const list = staff
    .map(
      (s, idx) =>
        `${idx + 1}. ID: ${s.id} - ${s.name}\n` +
        `   Specialization: ${s.specialization || 'N/A'}\n` +
        `   Rating: ${s.rating !== undefined ? s.rating : 'N/A'}` +
        (s.position?.title ? `\n   Position: ${s.position.title} (ID: ${s.position.id})` : '')
    )
    .join('\n\n');

  return summary + list;
}

export function formatServicesList(services: AltegioService[], companyId: number): string {
  const summary = `Found ${services.length} ${services.length === 1 ? 'service' : 'services'} for company ${companyId}:\n\n`;

  if (services.length === 0) return summary;

  const list = services
    .map(
      (s, idx) =>
        `${idx + 1}. ID: ${s.id} - "${s.title}"\n` +
        `   Price: ${s.cost}` +
        (s.duration ? `\n   Duration: ${s.duration} min` : '') +
        (s.category_id ? `\n   Category ID: ${s.category_id}` : '')
    )
    .join('\n\n');

  return summary + list;
}

export function formatBookingsList(bookings: AltegioBooking[], companyId: number): string {
  const summary = `Found ${bookings.length} ${bookings.length === 1 ? 'booking' : 'bookings'} for company ${companyId}:\n\n`;

  if (bookings.length === 0) return summary;

  const list = bookings
    .map(
      (b, idx) =>
        `${idx + 1}. Booking ID: ${b.id}\n` +
        `   Date: ${b.datetime || b.date}\n` +
        `   Client: ${b.client?.name || 'N/A'} (${b.client?.phone || 'no phone'})\n` +
        `   Staff: ${b.staff?.name || 'N/A'}\n` +
        `   Services: ${b.services?.map((s) => s.title).join(', ') || 'N/A'}\n` +
        `   Status: ${b.status}`
    )
    .join('\n\n');

  return summary + list;
}

export function formatCompaniesList(companies: AltegioCompany[], isUserCompanies: boolean): string {
  const summary = `Found ${companies.length} ${companies.length === 1 ? 'company' : 'companies'}${isUserCompanies ? ' (user companies)' : ''}:\n\n`;

  if (companies.length === 0) return summary;

  const list = companies
    .map(
      (c, idx) =>
        `${idx + 1}. ID: ${c.id} - "${c.title || c.public_title}"\n` +
        `   Address: ${c.address || 'N/A'}\n` +
        `   Phone: ${c.phone || 'N/A'}`
    )
    .join('\n\n');

  return summary + list;
}

export function formatCategoriesList(categories: AltegioServiceCategory[], companyId: number): string {
  const summary = `Found ${categories.length} service ${categories.length === 1 ? 'category' : 'categories'} for company ${companyId}:\n\n`;

  if (categories.length === 0) return summary;

  const list = categories
    .map(
      (c, idx) =>
        `${idx + 1}. ID: ${c.id} - "${c.title}"` +
        (c.services ? `\n   Services count: ${c.services.length}` : '')
    )
    .join('\n\n');

  return summary + list;
}

export function formatPositionsList(positions: AltegioPosition[]): string {
  if (!positions || positions.length === 0) {
    return 'No positions found for this company.';
  }

  const list = positions
    .map((p, idx) => `${idx + 1}. ${p.title} (ID: ${p.id})`)
    .join('\n');

  return `Found ${positions.length} position(s):\n\n${list}`;
}

export function formatScheduleList(schedule: AltegioScheduleEntry[], staffId: number): string {
  const summary = `Found ${schedule.length} schedule ${schedule.length === 1 ? 'entry' : 'entries'} for staff ${staffId}:\n\n`;

  if (schedule.length === 0) return summary;

  const list = schedule
    .map((s, idx) => `${idx + 1}. ${s.date} at ${s.time} (${s.seance_length} min)`)
    .join('\n');

  return summary + list;
}
