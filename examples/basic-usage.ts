/**
 * Basic Usage Example
 *
 * This example demonstrates how to use the Altegio MCP client directly
 * without the MCP server layer.
 */

import 'dotenv/config';
import { AltegioClient } from '../src/providers/altegio-client.js';
import type { AltegioConfig } from '../src/types/altegio.types.js';

async function main() {
  // Configure the client
  const config: AltegioConfig = {
    apiBase: process.env.ALTEGIO_API_BASE || 'https://api.alteg.io/api/v1',
    partnerToken: process.env.ALTEGIO_API_TOKEN!,
    timeout: 30000,
    retryConfig: {
      maxAttempts: 3,
      initialDelay: 1000,
      maxDelay: 30000,
    },
    rateLimit: {
      requests: 200,
      windowMs: 60000,
    },
  };

  const client = new AltegioClient(config);

  try {
    // 1. Login with email and password
    console.log('Logging in...');
    const loginResponse = await client.login(
      'your.email@example.com',
      'your-password'
    );

    if (loginResponse.success) {
      console.log('✅ Login successful!');
      console.log('User ID:', loginResponse.data?.id);
    }

    // 2. Get list of companies
    console.log('\nFetching companies...');
    const companiesResponse = await client.getCompanies();

    if (companiesResponse.success && companiesResponse.data) {
      console.log(`✅ Found ${companiesResponse.data.length} companies:`);

      companiesResponse.data.slice(0, 3).forEach(company => {
        console.log(`  - ${company.title} (ID: ${company.id})`);
        console.log(`    Location: ${company.city}, ${company.country}`);
      });

      // Use first company for further operations
      const companyId = companiesResponse.data[0].id;

      // 3. Get bookings for this month
      console.log(`\nFetching bookings for company ${companyId}...`);
      const now = new Date();
      const startDate = new Date(now.getFullYear(), now.getMonth(), 1)
        .toISOString()
        .split('T')[0];
      const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0)
        .toISOString()
        .split('T')[0];

      const bookingsResponse = await client.getBookings(companyId, {
        start_date: startDate,
        end_date: endDate,
        page: 1,
        count: 10,
      });

      if (bookingsResponse.success && bookingsResponse.data) {
        console.log(`✅ Found ${bookingsResponse.data.length} bookings:`);

        bookingsResponse.data.slice(0, 5).forEach(booking => {
          console.log(`  - ${booking.date}`);
          console.log(`    Staff: ${booking.staff.name}`);
          console.log(`    Client: ${booking.client?.name || 'N/A'}`);
        });

        // 5. Get details of first booking
        if (bookingsResponse.data.length > 0) {
          const bookingId = bookingsResponse.data[0].id;
          console.log(`\nFetching booking details for ID ${bookingId}...`);

          const bookingDetails = await client.getBooking(companyId, bookingId);

          if (bookingDetails.success) {
            console.log('✅ Booking details:');
            console.log(`  Date: ${bookingDetails.data.datetime}`);
            console.log(`  Duration: ${bookingDetails.data.duration} minutes`);
            console.log(`  Status: ${bookingDetails.data.status}`);

            if (bookingDetails.data.services.length > 0) {
              console.log('  Services:');
              bookingDetails.data.services.forEach(service => {
                console.log(`    - ${service.title}: ${service.cost}`);
              });
            }
          }
        }
      }
    }

    // 6. Logout
    console.log('\nLogging out...');
    const logoutResponse = await client.logout();
    if (logoutResponse.success) {
      console.log('✅ Logged out successfully!');
    }

  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  }
}

// Run the example
main()
  .then(() => {
    console.log('\n✨ Example completed successfully!');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n💥 Example failed:', error);
    process.exit(1);
  });
