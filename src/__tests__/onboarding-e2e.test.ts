import { OnboardingHandlers } from '../tools/onboarding-handlers';
import { AltegioClient } from '../providers/altegio-client';
import { OnboardingStateManager } from '../providers/onboarding-state-manager';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Onboarding E2E Flow', () => {
  let handlers: OnboardingHandlers;
  let mockClient: jest.Mocked<AltegioClient>;
  let stateManager: OnboardingStateManager;
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-e2e-'));
    stateManager = new OnboardingStateManager(testDir);

    // Create comprehensive mock client with all CRUD methods
    mockClient = {
      isAuthenticated: jest.fn().mockReturnValue(true),
      createStaff: jest.fn(),
      createServiceCategory: jest.fn(),
      createService: jest.fn(),
      createClient: jest.fn(),
      createBooking: jest.fn(),
      deleteStaff: jest.fn(),
      deleteBooking: jest.fn(),
    } as any;

    handlers = new OnboardingHandlers(mockClient, stateManager);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('Complete Onboarding Workflow', () => {
    it('should complete full onboarding workflow from start to finish', async () => {
      const companyId = 123;

      // Step 1: Start onboarding session
      const startResult = await handlers.start({ company_id: companyId });
      expect(startResult.content[0]?.text).toContain('Onboarding session started');

      let state = await stateManager.load(companyId);
      expect(state?.phase).toBe('init');
      expect(state?.company_id).toBe(companyId);
      expect(state?.checkpoints).toEqual({});

      // Step 2: Add service categories
      mockClient.createServiceCategory = jest.fn()
        .mockResolvedValueOnce({ id: 10, title: 'Hair Services' })
        .mockResolvedValueOnce({ id: 11, title: 'Nail Services' });

      const categoriesResult = await handlers.addCategories({
        company_id: companyId,
        categories: [
          { title: 'Hair Services', weight: 1 },
          { title: 'Nail Services', weight: 2 }
        ]
      });
      expect(categoriesResult.content[0]?.text).toContain('2 categories created');

      state = await stateManager.load(companyId);
      expect(state?.checkpoints['categories']).toBeDefined();
      expect(state?.checkpoints['categories']?.entity_ids).toEqual([10, 11]);
      expect(state?.phase).toBe('services');

      // Step 3: Add staff using CSV
      mockClient.createStaff = jest.fn()
        .mockResolvedValueOnce({ id: 1, name: 'Alice Johnson', specialization: 'Hairdresser' })
        .mockResolvedValueOnce({ id: 2, name: 'Bob Smith', specialization: 'Nail Technician' })
        .mockResolvedValueOnce({ id: 3, name: 'Carol White', specialization: 'Massage Therapist' });

      const staffCSV = `name,specialization,phone,email
Alice Johnson,Hairdresser,+1234567890,alice@salon.com
Bob Smith,Nail Technician,+1234567891,bob@salon.com
Carol White,Massage Therapist,+1234567892,carol@salon.com`;

      const staffResult = await handlers.addStaffBatch({
        company_id: companyId,
        staff_data: staffCSV
      });
      expect(staffResult.content[0]?.text).toContain('3 staff members created');
      expect(mockClient.createStaff).toHaveBeenCalledTimes(3);

      state = await stateManager.load(companyId);
      expect(state?.checkpoints['staff']).toBeDefined();
      expect(state?.checkpoints['staff']?.entity_ids).toEqual([1, 2, 3]);
      expect(state?.phase).toBe('categories');

      // Step 4: Add services using JSON
      mockClient.createService = jest.fn()
        .mockResolvedValueOnce({ id: 20, title: 'Women\'s Haircut', category_id: 10 })
        .mockResolvedValueOnce({ id: 21, title: 'Men\'s Haircut', category_id: 10 })
        .mockResolvedValueOnce({ id: 22, title: 'Manicure', category_id: 11 })
        .mockResolvedValueOnce({ id: 23, title: 'Pedicure', category_id: 11 });

      const servicesResult = await handlers.addServicesBatch({
        company_id: companyId,
        services_data: [
          { title: 'Women\'s Haircut', price_min: 60, price_max: 80, duration: 2700, category_id: 10 },
          { title: 'Men\'s Haircut', price_min: 40, price_max: 50, duration: 1800, category_id: 10 },
          { title: 'Manicure', price_min: 35, duration: 1800, category_id: 11 },
          { title: 'Pedicure', price_min: 45, duration: 2400, category_id: 11 }
        ]
      });
      expect(servicesResult.content[0]?.text).toContain('4 services created');
      expect(mockClient.createService).toHaveBeenCalledTimes(4);

      state = await stateManager.load(companyId);
      expect(state?.checkpoints['services']).toBeDefined();
      expect(state?.checkpoints['services']?.entity_ids).toEqual([20, 21, 22, 23]);
      expect(state?.phase).toBe('clients');

      // Step 5: Import clients from CSV
      mockClient.createClient = jest.fn()
        .mockResolvedValueOnce({ id: 30, name: 'John Doe' })
        .mockResolvedValueOnce({ id: 31, name: 'Jane Smith' })
        .mockResolvedValueOnce({ id: 32, name: 'Mike Johnson' });

      const clientsCSV = `name,phone,email,surname
John,+1555001001,john.doe@email.com,Doe
Jane,+1555001002,jane.smith@email.com,Smith
Mike,+1555001003,mike.johnson@email.com,Johnson`;

      const clientsResult = await handlers.importClients({
        company_id: companyId,
        clients_csv: clientsCSV
      });
      expect(clientsResult.content[0]?.text).toContain('3 clients imported');
      expect(mockClient.createClient).toHaveBeenCalledTimes(3);

      state = await stateManager.load(companyId);
      expect(state?.checkpoints['clients']).toBeDefined();
      expect(state?.checkpoints['clients']?.entity_ids).toEqual([30, 31, 32]);
      expect(state?.phase).toBe('test_bookings');

      // Step 6: Create test bookings
      let bookingIdCounter = 100;
      mockClient.createBooking = jest.fn()
        .mockImplementation(() => Promise.resolve({
          id: bookingIdCounter++,
          staff_id: 1,
          datetime: '2025-02-01 10:00:00'
        }));

      const bookingsResult = await handlers.createTestBookings({
        company_id: companyId,
        count: 5
      });
      expect(bookingsResult.content[0]?.text).toContain('Test bookings created: 5');
      expect(bookingsResult.content[0]?.text).toContain('Onboarding complete!');
      expect(mockClient.createBooking).toHaveBeenCalledTimes(5);

      state = await stateManager.load(companyId);
      expect(state?.checkpoints['test_bookings']).toBeDefined();
      expect(state?.checkpoints['test_bookings']?.entity_ids).toHaveLength(5);
      expect(state?.phase).toBe('complete');

      // Verify final summary
      expect(bookingsResult.content[0]?.text).toContain('Staff: 3');
      expect(bookingsResult.content[0]?.text).toContain('Services: 4');
      expect(bookingsResult.content[0]?.text).toContain('Test bookings: 5');

      // Verify all checkpoints are in place
      expect(Object.keys(state?.checkpoints || {})).toHaveLength(5);
      expect(state?.checkpoints['categories']?.completed).toBe(true);
      expect(state?.checkpoints['staff']?.completed).toBe(true);
      expect(state?.checkpoints['services']?.completed).toBe(true);
      expect(state?.checkpoints['clients']?.completed).toBe(true);
      expect(state?.checkpoints['test_bookings']?.completed).toBe(true);
    });

    it('should handle phase progression correctly', async () => {
      const companyId = 456;

      await handlers.start({ company_id: companyId });
      expect((await stateManager.load(companyId))?.phase).toBe('init');

      // Categories phase
      mockClient.createServiceCategory = jest.fn()
        .mockResolvedValue({ id: 10, title: 'Test' });
      await handlers.addCategories({
        company_id: companyId,
        categories: [{ title: 'Test Category' }]
      });
      expect((await stateManager.load(companyId))?.phase).toBe('services');

      // Staff phase (updates to categories after checkpoint)
      mockClient.createStaff = jest.fn()
        .mockResolvedValue({ id: 1, name: 'Test' });
      await handlers.addStaffBatch({
        company_id: companyId,
        staff_data: [{ name: 'Test Staff', specialization: 'Test' }]
      });
      expect((await stateManager.load(companyId))?.phase).toBe('categories');

      // Services phase
      mockClient.createService = jest.fn()
        .mockResolvedValue({ id: 20, title: 'Test' });
      await handlers.addServicesBatch({
        company_id: companyId,
        services_data: [{ title: 'Test Service', price_min: 50, duration: 1800 }]
      });
      expect((await stateManager.load(companyId))?.phase).toBe('clients');
    });

    it('should verify state persistence across operations', async () => {
      const companyId = 789;

      // Start and add categories
      await handlers.start({ company_id: companyId });
      mockClient.createServiceCategory = jest.fn()
        .mockResolvedValue({ id: 1, title: 'Category 1' });
      await handlers.addCategories({
        company_id: companyId,
        categories: [{ title: 'Category 1' }]
      });

      // Verify state persisted to disk
      const savedState = await stateManager.load(companyId);
      expect(savedState).not.toBeNull();
      expect(savedState?.checkpoints['categories']?.entity_ids).toEqual([1]);

      // Create new handler instance (simulates new process)
      const newHandlers = new OnboardingHandlers(mockClient, stateManager);

      // Verify it can read existing state
      const statusResult = await newHandlers.status({ company_id: companyId });
      expect(statusResult.content[0]?.text).toContain('Phase: services');
      expect(statusResult.content[0]?.text).toContain('Total entities created: 1');
      expect(statusResult.content[0]?.text).toContain('Phases completed: 1');
    });
  });

  describe('Resume Functionality', () => {
    it('should resume after interruption and continue workflow', async () => {
      const companyId = 234;

      // Start and add staff
      await handlers.start({ company_id: companyId });

      mockClient.createStaff = jest.fn()
        .mockResolvedValueOnce({ id: 1, name: 'Alice' })
        .mockResolvedValueOnce({ id: 2, name: 'Bob' });

      await handlers.addStaffBatch({
        company_id: companyId,
        staff_data: [
          { name: 'Alice', specialization: 'Test' },
          { name: 'Bob', specialization: 'Test' }
        ]
      });

      // Simulate interruption - create new handler instance
      const newHandlers = new OnboardingHandlers(mockClient, stateManager);

      // Resume session
      const resumeResult = await newHandlers.resume({ company_id: companyId });
      expect(resumeResult.content[0]?.text).toContain('Onboarding session for company 234');
      expect(resumeResult.content[0]?.text).toContain('Current phase: categories');
      expect(resumeResult.content[0]?.text).toContain('staff: 2 entities created');

      // Continue workflow from where we left off
      mockClient.createServiceCategory = jest.fn()
        .mockResolvedValue({ id: 10, title: 'Hair' });

      await newHandlers.addCategories({
        company_id: companyId,
        categories: [{ title: 'Hair Services' }]
      });

      const state = await stateManager.load(companyId);
      expect(Object.keys(state!.checkpoints)).toHaveLength(2);
      expect(state?.checkpoints['staff']?.entity_ids).toEqual([1, 2]);
      expect(state?.checkpoints['categories']?.entity_ids).toEqual([10]);
    });

    it('should show accurate progress summary when resuming', async () => {
      const companyId = 567;

      // Setup partial progress
      await handlers.start({ company_id: companyId });

      mockClient.createServiceCategory = jest.fn()
        .mockResolvedValueOnce({ id: 10, title: 'Cat1' })
        .mockResolvedValueOnce({ id: 11, title: 'Cat2' });
      await handlers.addCategories({
        company_id: companyId,
        categories: [{ title: 'Cat1' }, { title: 'Cat2' }]
      });

      mockClient.createStaff = jest.fn()
        .mockResolvedValueOnce({ id: 1, name: 'Staff1' })
        .mockResolvedValueOnce({ id: 2, name: 'Staff2' })
        .mockResolvedValueOnce({ id: 3, name: 'Staff3' });
      await handlers.addStaffBatch({
        company_id: companyId,
        staff_data: [
          { name: 'Staff1' },
          { name: 'Staff2' },
          { name: 'Staff3' }
        ]
      });

      mockClient.createService = jest.fn()
        .mockResolvedValueOnce({ id: 20, title: 'Service1' });
      await handlers.addServicesBatch({
        company_id: companyId,
        services_data: [{ title: 'Service1', price_min: 50, duration: 1800 }]
      });

      // Resume and check progress
      const resumeResult = await handlers.resume({ company_id: companyId });
      const text = resumeResult.content[0]?.text;

      expect(text).toContain('categories: 2 entities created');
      expect(text).toContain('staff: 3 entities created');
      expect(text).toContain('services: 1 entities created');
      expect(text).toContain('Current phase: clients');
    });

    it('should handle resume with no session', async () => {
      await expect(handlers.resume({ company_id: 999 }))
        .rejects.toThrow('No onboarding session found for company 999');
    });

    it('should resume with no completed checkpoints', async () => {
      const companyId = 890;

      await handlers.start({ company_id: companyId });

      const resumeResult = await handlers.resume({ company_id: companyId });
      expect(resumeResult.content[0]?.text).toContain('(none yet)');
      expect(resumeResult.content[0]?.text).toContain('Current phase: init');
    });
  });

  describe('Status Tracking', () => {
    it('should track status throughout workflow', async () => {
      const companyId = 321;

      await handlers.start({ company_id: companyId });

      // Check initial status
      let statusResult = await handlers.status({ company_id: companyId });
      expect(statusResult.content[0]?.text).toContain('Phase: init');
      expect(statusResult.content[0]?.text).toContain('Total entities created: 0');
      expect(statusResult.content[0]?.text).toContain('Phases completed: 0');

      // Add categories and check status
      mockClient.createServiceCategory = jest.fn()
        .mockResolvedValueOnce({ id: 10, title: 'Test' });
      await handlers.addCategories({
        company_id: companyId,
        categories: [{ title: 'Test' }]
      });

      statusResult = await handlers.status({ company_id: companyId });
      expect(statusResult.content[0]?.text).toContain('Phase: services');
      expect(statusResult.content[0]?.text).toContain('Total entities created: 1');
      expect(statusResult.content[0]?.text).toContain('Phases completed: 1');

      // Add staff and services
      mockClient.createStaff = jest.fn()
        .mockResolvedValueOnce({ id: 1, name: 'Staff' })
        .mockResolvedValueOnce({ id: 2, name: 'Staff2' });
      await handlers.addStaffBatch({
        company_id: companyId,
        staff_data: [{ name: 'Staff' }, { name: 'Staff2' }]
      });

      mockClient.createService = jest.fn()
        .mockResolvedValueOnce({ id: 20, title: 'Service' })
        .mockResolvedValueOnce({ id: 21, title: 'Service2' })
        .mockResolvedValueOnce({ id: 22, title: 'Service3' });
      await handlers.addServicesBatch({
        company_id: companyId,
        services_data: [
          { title: 'Service', price_min: 50, duration: 1800 },
          { title: 'Service2', price_min: 60, duration: 1800 },
          { title: 'Service3', price_min: 70, duration: 1800 }
        ]
      });

      statusResult = await handlers.status({ company_id: companyId });
      expect(statusResult.content[0]?.text).toContain('Total entities created: 6'); // 1 cat + 2 staff + 3 services
      expect(statusResult.content[0]?.text).toContain('Phases completed: 3');
    });
  });

  describe('Error Handling and Recovery', () => {
    it('should track partial success when some entities fail', async () => {
      const companyId = 654;

      await handlers.start({ company_id: companyId });

      // Mock mixed success/failure for staff creation
      mockClient.createStaff = jest.fn()
        .mockResolvedValueOnce({ id: 1, name: 'Alice' })
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({ id: 3, name: 'Carol' });

      const result = await handlers.addStaffBatch({
        company_id: companyId,
        staff_data: [
          { name: 'Alice', specialization: 'Hair' },
          { name: 'Bob', specialization: 'Nails' },
          { name: 'Carol', specialization: 'Massage' }
        ]
      });

      expect(result.content[0]?.text).toContain('2 staff members created');
      expect(result.content[0]?.text).toContain('1 failed');
      expect(result.content[0]?.text).toContain('Network error');

      // Verify only successful entities were checkpointed
      const state = await stateManager.load(companyId);
      expect(state?.checkpoints['staff']?.entity_ids).toEqual([1, 3]);
    });

    it('should allow workflow to continue after partial failures', async () => {
      const companyId = 987;

      await handlers.start({ company_id: companyId });

      // Staff with partial failure
      mockClient.createStaff = jest.fn()
        .mockResolvedValueOnce({ id: 1, name: 'Staff1' });
      await handlers.addStaffBatch({
        company_id: companyId,
        staff_data: [{ name: 'Staff1' }]
      });

      // Continue to next phase
      mockClient.createServiceCategory = jest.fn()
        .mockResolvedValue({ id: 10, title: 'Cat1' });
      const result = await handlers.addCategories({
        company_id: companyId,
        categories: [{ title: 'Cat1' }]
      });

      expect(result.content[0]?.text).toContain('1 categories created');

      const state = await stateManager.load(companyId);
      expect(state?.checkpoints['staff']).toBeDefined();
      expect(state?.checkpoints['categories']).toBeDefined();
    });

    it('should require authentication for all operations', async () => {
      mockClient.isAuthenticated = jest.fn().mockReturnValue(false);

      await expect(handlers.start({ company_id: 123 }))
        .rejects.toThrow('Authentication required');

      await expect(handlers.resume({ company_id: 123 }))
        .rejects.toThrow('Authentication required');

      await expect(handlers.status({ company_id: 123 }))
        .rejects.toThrow('Authentication required');
    });

    it('should reject test bookings if prerequisites missing', async () => {
      const companyId = 111;

      await handlers.start({ company_id: companyId });

      // Try to create bookings without staff/services
      await expect(
        handlers.createTestBookings({ company_id: companyId, count: 2 })
      ).rejects.toThrow('No staff or services found');

      // Add only staff
      mockClient.createStaff = jest.fn()
        .mockResolvedValue({ id: 1, name: 'Staff' });
      await handlers.addStaffBatch({
        company_id: companyId,
        staff_data: [{ name: 'Staff' }]
      });

      // Still should fail without services
      await expect(
        handlers.createTestBookings({ company_id: companyId, count: 2 })
      ).rejects.toThrow('No staff or services found');
    });
  });

  describe('Test Bookings Generation', () => {
    it('should distribute bookings across staff and services', async () => {
      const companyId = 222;

      await handlers.start({ company_id: companyId });

      // Setup staff and services
      await stateManager.checkpoint(companyId, 'staff', [1, 2, 3]);
      await stateManager.checkpoint(companyId, 'services', [10, 11]);

      const bookingCalls: any[] = [];
      mockClient.createBooking = jest.fn()
        .mockImplementation((_companyId, data) => {
          bookingCalls.push(data);
          return Promise.resolve({ id: 100 + bookingCalls.length });
        });

      await handlers.createTestBookings({
        company_id: companyId,
        count: 6
      });

      // Verify bookings were distributed
      expect(bookingCalls).toHaveLength(6);

      // Check staff rotation (3 staff: 1, 2, 3, 1, 2, 3)
      expect(bookingCalls[0]?.staff_id).toBe(1);
      expect(bookingCalls[1]?.staff_id).toBe(2);
      expect(bookingCalls[2]?.staff_id).toBe(3);
      expect(bookingCalls[3]?.staff_id).toBe(1);

      // Check service rotation (2 services: 10, 11, 10, 11, ...)
      expect(bookingCalls[0]?.services[0]?.id).toBe(10);
      expect(bookingCalls[1]?.services[0]?.id).toBe(11);
      expect(bookingCalls[2]?.services[0]?.id).toBe(10);

      // Verify all bookings have test client data
      bookingCalls.forEach((call, idx) => {
        expect(call.client.name).toBe(`Test Client ${idx + 1}`);
        expect(call.client.phone).toMatch(/^\+100000000\d$/);
        expect(call.datetime).toMatch(/^\d{4}-\d{2}-\d{2} 10:00:00$/);
      });
    });

    it('should respect max booking count limit', async () => {
      const companyId = 333;

      await handlers.start({ company_id: companyId });
      await stateManager.checkpoint(companyId, 'staff', [1]);
      await stateManager.checkpoint(companyId, 'services', [10]);

      mockClient.createBooking = jest.fn()
        .mockResolvedValue({ id: 100 });

      // Max is 10
      await handlers.createTestBookings({
        company_id: companyId,
        count: 10
      });

      expect(mockClient.createBooking).toHaveBeenCalledTimes(10);
    });

    it('should handle booking creation failures gracefully', async () => {
      const companyId = 444;

      await handlers.start({ company_id: companyId });
      await stateManager.checkpoint(companyId, 'staff', [1]);
      await stateManager.checkpoint(companyId, 'services', [10]);

      // Mock some failures
      mockClient.createBooking = jest.fn()
        .mockResolvedValueOnce({ id: 100 })
        .mockRejectedValueOnce(new Error('Booking conflict'))
        .mockResolvedValueOnce({ id: 102 });

      const result = await handlers.createTestBookings({
        company_id: companyId,
        count: 3
      });

      // Should only checkpoint successful bookings
      expect(result.content[0]?.text).toContain('Test bookings created: 2');

      const state = await stateManager.load(companyId);
      expect(state?.checkpoints['test_bookings']?.entity_ids).toEqual([100, 102]);
    });
  });

  describe('Complex Multi-Phase Scenarios', () => {
    it('should handle multiple companies independently', async () => {
      const companyId1 = 1001;
      const companyId2 = 1002;

      // Start sessions for both companies
      await handlers.start({ company_id: companyId1 });
      await handlers.start({ company_id: companyId2 });

      // Progress company 1
      mockClient.createServiceCategory = jest.fn()
        .mockResolvedValue({ id: 10, title: 'Cat1' });
      await handlers.addCategories({
        company_id: companyId1,
        categories: [{ title: 'Cat1' }]
      });

      // Progress company 2 differently
      mockClient.createStaff = jest.fn()
        .mockResolvedValue({ id: 1, name: 'Staff' });
      await handlers.addStaffBatch({
        company_id: companyId2,
        staff_data: [{ name: 'Staff' }]
      });

      // Verify independent states
      const state1 = await stateManager.load(companyId1);
      const state2 = await stateManager.load(companyId2);

      expect(state1?.phase).toBe('services');
      expect(state1?.checkpoints['categories']).toBeDefined();
      expect(state1?.checkpoints['staff']).toBeUndefined();

      expect(state2?.phase).toBe('categories');
      expect(state2?.checkpoints['staff']).toBeDefined();
      expect(state2?.checkpoints['categories']).toBeUndefined();
    });

    it('should maintain checkpoint metadata and timestamps', async () => {
      const companyId = 555;

      await handlers.start({ company_id: companyId });

      const beforeTime = Date.now();

      mockClient.createServiceCategory = jest.fn()
        .mockResolvedValue({ id: 10, title: 'Test' });
      await handlers.addCategories({
        company_id: companyId,
        categories: [{ title: 'Test' }]
      });

      const afterTime = Date.now();

      const state = await stateManager.load(companyId);
      const checkpoint = state?.checkpoints['categories'];

      expect(checkpoint?.completed).toBe(true);
      expect(checkpoint?.timestamp).toBeDefined();

      // Compare timestamp as Date objects
      const checkpointTime = new Date(checkpoint!.timestamp).getTime();
      expect(checkpointTime).toBeGreaterThanOrEqual(beforeTime);
      expect(checkpointTime).toBeLessThanOrEqual(afterTime);
    });
  });
});
