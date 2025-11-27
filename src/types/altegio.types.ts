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
  date: string;
  time: string;
  seance_length: number;
  datetime: string;
}

// ========== Write Operation Request Types ==========

// Schedule
export interface CreateScheduleRequest {
  staff_id: number;
  date: string; // YYYY-MM-DD
  time_from: string; // HH:MM
  time_to: string; // HH:MM
  seance_length?: number; // Duration in minutes
}

export interface UpdateScheduleRequest {
  staff_id: number;
  date: string; // YYYY-MM-DD
  time_from?: string; // HH:MM
  time_to?: string; // HH:MM
  seance_length?: number; // Duration in minutes
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
  position_id?: number | null;
  phone_number?: string | null;
  hidden?: number;
  fired?: number;
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
