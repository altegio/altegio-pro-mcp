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
    // 1. Log in with email and password
    console.log('Logging in...');
    const loginResponse = await client.login(
      'your.email@example.com',
      'your-password'
    );

    if (!loginResponse.success) {
      console.error(
        `❌ Login failed: ${loginResponse.error ?? 'unknown error'}`
      );
      return;
    }
    console.log('✅ Login successful!');

    // 2. Get the list of locations (returned as a plain array)
    console.log('\nFetching locations...');
    const locations = await client.getCompanies();
    console.log(`✅ Found ${locations.length} locations:`);

    locations.slice(0, 3).forEach((location) => {
      console.log(`  - ${location.title} (ID: ${location.id})`);
      console.log(`    ${location.city}, ${location.country}`);
    });

    // Use the first location for further operations
    const firstLocation = locations[0];
    if (firstLocation) {
      const locationId = firstLocation.id;

      // 3. Get appointments for this month
      console.log(`\nFetching appointments for location ${locationId}...`);
      const now = new Date();
      const startDate = new Date(now.getFullYear(), now.getMonth(), 1)
        .toISOString()
        .slice(0, 10);
      const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0)
        .toISOString()
        .slice(0, 10);

      const appointments = await client.getBookings(locationId, {
        start_date: startDate,
        end_date: endDate,
        page: 1,
        count: 10,
      });
      console.log(`✅ Found ${appointments.length} appointments:`);

      appointments.slice(0, 5).forEach((appointment) => {
        console.log(`  - ${appointment.date}`);
        console.log(`    Staff: ${appointment.staff.name}`);
        console.log(`    Client: ${appointment.client?.name || 'N/A'}`);
      });

      // 4. Inspect the first appointment
      //    (getBookings already returns full appointment objects,
      //     so no extra request is needed for the details)
      const firstAppointment = appointments[0];
      if (firstAppointment) {
        console.log(`\n✅ Details for appointment ID ${firstAppointment.id}:`);
        console.log(`  Date: ${firstAppointment.datetime}`);
        console.log(`  Duration: ${firstAppointment.duration} minutes`);
        console.log(`  Status: ${firstAppointment.status}`);

        if (firstAppointment.services.length > 0) {
          console.log('  Services:');
          firstAppointment.services.forEach((service) => {
            console.log(`    - ${service.title}: ${service.cost}`);
          });
        }
      }
    }

    // 5. Log out
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
  .catch((error) => {
    console.error('\n💥 Example failed:', error);
    process.exit(1);
  });
