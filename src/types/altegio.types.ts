/**
 * Altegio API Type Definitions
 */

export interface AltegioConfig {
  apiBase?: string;
  partnerToken: string;
  userToken?: string;
  timeout?: number;
  retryConfig?: {
    maxAttempts?: number;
    initialDelay?: number;
    maxDelay?: number;
  };
  rateLimit?: {
    requests?: number;
    windowMs?: number;
  };
}

export interface AltegioCredentials {
  user_token: string;
  user_id: number;
  updated_at: string;
}

export interface AltegioLoginRequest {
  login: string;
  password: string;
}

export interface AltegioLoginResponse {
  success: boolean;
  data: {
    user_token: string;
    id: number;
  } | null;
  meta?: {
    message?: string;
  };
}

export interface AltegioCompany {
  id: number;
  title: string;
  public_title: string;
  short_descr: string;
  logo?: string;
  country_id: number;
  country: string;
  city_id: number;
  city: string;
  active: number;
  phone: string;
  phones: string[];
  email: string;
  timezone: number;
  timezone_name: string;
  schedule: string;
  address: string;
  coordinate_lat?: number;
  coordinate_lon?: number;
  currency_short_title: string;
  site?: string;
  business_type_id: number;
  [key: string]: unknown; // Additional properties
}

export interface AltegioBooking {
  id: number;
  company_id: number;
  staff_id: number;
  staff: {
    id: number;
    name: string;
    specialization?: string;
    rating?: number;
  };
  services: Array<{
    id: number;
    title: string;
    cost: number;
    currency?: string;
  }>;
  client: {
    id: number;
    name: string;
    phone?: string;
    email?: string;
    visits_count?: number;
  };
  date: string;
  datetime: string;
  duration: number;
  status: string;
  paid_status?: string;
  payment_status?: string;
  prepaid?: boolean;
  prepaid_amount?: number;
  comment?: string;
  [key: string]: unknown;
}

export interface AltegioApiResponse<T> {
  success: boolean;
  data: T;
  meta?: {
    page?: number;
    total_count?: number;
    message?: string;
    [key: string]: unknown;
  };
}

export interface AltegioListParams {
  start_date?: string;
  end_date?: string;
  page?: number;
  count?: number;
  [key: string]: unknown;
}

export interface AltegioCompaniesParams {
  my?: number;
  page?: number;
  count?: number;
  [key: string]: unknown;
}

export interface AltegioError extends Error {
  code?: number;
  statusCode?: number;
  response?: unknown;
}

// Public booking API types (no user auth required)

export interface AltegioPosition {
  id: number;
  title: string;
  api_id?: string | null;
  [key: string]: unknown;
}

export interface AltegioStaff {
  id: number;
  api_id?: string | null;
  name: string;
  specialization?: string;
  rating?: number;
  avatar?: string;
  position?: {
    id: number;
    title: string;
  };
  schedule_till?: string;
  [key: string]: unknown;
}

export interface AltegioService {
  id: number;
  title: string;
  cost: number;
  discount?: number;
  category_id?: number;
  duration?: number;
  api_id?: string | null;
  price_min?: number;
  price_max?: number;
  [key: string]: unknown;
}

export interface AltegioServiceCategory {
  id: number;
  title: string;
  api_id?: string | null;
  sex?: number;
  services?: AltegioService[];
  [key: string]: unknown;
}

export interface AltegioBookingParams {
  staff_id?: number;
  service_id?: number;
  date?: string;
  [key: string]: unknown;
}

export interface AltegioScheduleEntry {
  staff_id?: number;
  date: string;
  time?: string;
  seance_length?: number;
  datetime?: string;
  slots?: Array<{ from: string; to: string }>;
  [key: string]: unknown;
}

// ========== Write Operation Request Types ==========

// Schedule — matches PUT /company/{location_id}/staff/schedule spec
export interface ScheduleSlot {
  from: string; // HH:mm
  to: string; // HH:mm
}

export interface ScheduleToSet {
  team_member_id: number;
  dates: string[]; // YYYY-MM-DD
  slots: ScheduleSlot[];
}

export interface ScheduleToDelete {
  team_member_id: number;
  dates: string[]; // YYYY-MM-DD
}

export interface SetScheduleRequest {
  schedules_to_set?: ScheduleToSet[];
  schedules_to_delete?: ScheduleToDelete[];
}

/** @deprecated Use SetScheduleRequest instead */
export interface CreateScheduleRequest {
  staff_id: number;
  date: string;
  time_from: string;
  time_to: string;
  seance_length?: number;
}

/** @deprecated Use SetScheduleRequest instead */
export interface UpdateScheduleRequest {
  staff_id: number;
  date: string;
  time_from?: string;
  time_to?: string;
  seance_length?: number;
}

// Staff
export interface CreateStaffRequest {
  name: string;
  specialization: string;
  position_id: number | null;
  phone_number: string | null;
  user_email: string;
  user_phone: string;
  is_user_invite: boolean;
}

export interface UpdateStaffRequest {
  name?: string;
  specialization?: string;
  weight?: number;
  information?: string;
  api_id?: string;
  hidden?: number;
  fired?: number;
  user_id?: number;
}

// Services
export interface CreateServiceRequest {
  title: string;
  category_id: number;
  price_min?: number;
  price_max?: number;
  discount?: number;
  comment?: string;
  duration?: number;
  prepaid?: string;
}

export interface UpdateServiceRequest {
  title?: string;
  category_id?: number;
  price_min?: number;
  price_max?: number;
  discount?: number;
  comment?: string;
  duration?: number;
  active?: number;
}

// Bookings
export interface CreateBookingRequest {
  staff_id: number;
  services: Array<{ id: number; amount?: number }>;
  datetime: string;
  seance_length?: number;
  client: {
    name: string;
    phone: string;
    email?: string;
  };
  comment?: string;
  send_sms?: number;
  attendance?: number;
}

export interface UpdateBookingRequest {
  staff_id?: number;
  services?: Array<{ id: number; amount?: number }>;
  datetime?: string;
  seance_length?: number;
  client?: {
    name?: string;
    phone?: string;
    email?: string;
  };
  comment?: string;
  attendance?: number;
}

// Clients
export interface AltegioClientEntity {
  id: number;
  name: string;
  phone?: string;
  email?: string;
  surname?: string;
  [key: string]: unknown;
}

export interface CreateClientRequest {
  name: string;
  phone?: string;
  email?: string;
  surname?: string;
  comment?: string;
}

// Service Categories
export interface CreateCategoryRequest {
  title: string;
  api_id?: string;
  weight?: number;
}

// Positions
export interface CreatePositionRequest {
  title: string;
  api_id?: string;
}

export interface UpdatePositionRequest {
  title?: string;
  api_id?: string;
}

// ========== Location Settings & Resources ==========

// Appointment calendar settings — GET/PATCH /company/{id}/settings/timetable
export interface AppointmentSettings {
  /** Default appointment type: 0 - Mixed, 1 - Individual, 2 - Group event */
  record_type: number;
  /** Maximum number of seats in one group event (1-255) */
  activity_record_clients_count_max: number;
  is_show_newsletter_agreement?: boolean;
  is_show_personal_data_processing_agreement?: boolean;
  [key: string]: unknown;
}

export interface UpdateAppointmentSettingsRequest {
  record_type: number;
  activity_record_clients_count_max: number;
  is_show_newsletter_agreement?: boolean;
  is_show_personal_data_processing_agreement?: boolean;
}

// Online booking settings — GET/PATCH /company/{id}/settings/online
export interface OnlineBookingSettings {
  /** Confirm customer number via SMS */
  confirm_number: boolean;
  /** "Any team member" mode */
  any_master: boolean;
  /** Delay to the next session, minutes 0-1380 in steps of 30 */
  seance_delay_step: number;
  /** Maximum number of seats in one group event (1-255) */
  activity_online_record_clients_count_max: number;
  [key: string]: unknown;
}

export interface UpdateOnlineBookingSettingsRequest {
  confirm_number: boolean;
  any_master: boolean;
  seance_delay_step: number;
  activity_online_record_clients_count_max: number;
}

// Booking (appointment) forms — GET/POST /company/{id}/booking_forms
export interface BookingForm {
  id: number;
  title: string;
  description?: string;
  is_default?: boolean;
  [key: string]: unknown;
}

export interface CreateBookingFormRequest {
  title: string;
  description?: string;
  is_default?: boolean;
  /** Step mode flag ("without menu") */
  without_menu?: boolean;
}

// Resources — GET /resources/{id} (read-only; creation not exposed by the API)
export interface AltegioResourceInstance {
  id: number;
  title: string;
  resource_id: number;
  [key: string]: unknown;
}

export interface AltegioResource {
  id: number;
  title: string;
  instances?: AltegioResourceInstance[];
  [key: string]: unknown;
}
