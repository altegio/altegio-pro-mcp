# Onboarding Wizard Guide

Complete guide for using the conversational onboarding assistant to set up your Altegio business from scratch.

## Overview

The onboarding wizard provides **10 specialized tools** to help new users quickly configure their business platform through natural conversation or bulk data import. Perfect for first-time setup with staff, services, and client databases.

**Key Features:**
- Hybrid input: conversational or CSV/JSON bulk import
- Checkpoint/resume: automatically recover from errors
- Persistent state: track progress across sessions
- Test data generation: create sample bookings
- Phase-level rollback: undo specific setup steps

## Quick Start

### 1. Login and Start

```typescript
// First, authenticate
altegio_login({
  email: "your-email@example.com",
  password: "your-password"
})

// Start onboarding for your company
onboarding_start({
  company_id: 123456
})
// Response: "Onboarding session initialized for company 123456
//           State saved to ~/.altegio-mcp/onboarding/123456/
//           Next steps: Add service categories, then staff and services"
```

### 2. Add Service Categories

```typescript
onboarding_add_categories({
  company_id: 123456,
  categories: [
    { title: "Hair Services", api_id: "hair", weight: 1 },
    { title: "Nail Services", api_id: "nails", weight: 2 },
    { title: "Spa Treatments", api_id: "spa", weight: 3 }
  ]
})
// Response: "Successfully created 3 categories
//           IDs: [501, 502, 503]
//           Checkpoint saved at phase: categories"
```

### 3. Import Staff (CSV or JSON)

**Option A: JSON Array**
```typescript
onboarding_add_staff_batch({
  company_id: 123456,
  staff_data: [
    {
      name: "Alice Johnson",
      specialization: "Senior Stylist",
      phone: "+1234567890",
      email: "alice@salon.com"
    },
    {
      name: "Bob Smith",
      specialization: "Nail Technician",
      phone: "+1234567891"
    }
  ]
})
```

**Option B: CSV String**
```typescript
onboarding_add_staff_batch({
  company_id: 123456,
  staff_data: `name,specialization,phone,email
Alice Johnson,Senior Stylist,+1234567890,alice@salon.com
Bob Smith,Nail Technician,+1234567891,bob@salon.com
Carol White,Massage Therapist,+1234567892,carol@salon.com`
})

// Response: "Successfully created 3 staff members
//           Created IDs: [101, 102, 103]
//           Failed: 0
//           Checkpoint saved at phase: staff"
```

### 4. Add Services

```typescript
onboarding_add_services_batch({
  company_id: 123456,
  services_data: [
    {
      title: "Women's Haircut",
      price_min: 50,
      duration: 60,
      category_id: 501  // Hair Services
    },
    {
      title: "Hair Coloring",
      price_min: 80,
      price_max: 150,
      duration: 120,
      category_id: 501
    },
    {
      title: "Manicure",
      price_min: 30,
      duration: 45,
      category_id: 502  // Nail Services
    }
  ]
})
// Response: "Successfully created 3 services
//           Created IDs: [201, 202, 203]
//           Checkpoint saved at phase: services"
```

### 5. Import Client Database

```typescript
onboarding_import_clients({
  company_id: 123456,
  clients_csv: `name,phone,email,surname,comment
Sarah Miller,+1234560001,sarah@example.com,Miller,VIP client
John Davis,+1234560002,john@example.com,Davis,
Emma Wilson,+1234560003,,Wilson,Prefers email contact`
})

// Response: "Successfully imported 3 clients
//           Created IDs: [1001, 1002, 1003]
//           Skipped duplicates: 0
//           Checkpoint saved at phase: clients"
```

### 6. Generate Test Bookings

```typescript
onboarding_create_test_bookings({
  company_id: 123456,
  count: 5
})

// Response: "Successfully created 5 test bookings
//           Booking IDs: [301, 302, 303, 304, 305]
//           Distributed across next 7 days
//           Staff used: [101, 102, 103]
//           Services used: [201, 202, 203]
//           Checkpoint saved at phase: test_bookings"
```

### 7. Check Status

```typescript
onboarding_status({
  company_id: 123456
})

// Response: "Onboarding Status for Company 123456
//           Current phase: complete
//           Started: 2025-01-29T10:30:00.000Z
//
//           Completed Phases:
//           ✓ categories - 3 entities created (2025-01-29T10:31:15.000Z)
//           ✓ staff - 3 entities created (2025-01-29T10:32:45.000Z)
//           ✓ services - 3 entities created (2025-01-29T10:34:20.000Z)
//           ✓ clients - 3 entities created (2025-01-29T10:36:00.000Z)
//           ✓ test_bookings - 5 entities created (2025-01-29T10:37:30.000Z)
//
//           Status: Onboarding complete!"
```

## CSV Format Reference

### Staff CSV Template

```csv
name,specialization,phone,email,api_id
Alice Johnson,Senior Stylist,+1234567890,alice@salon.com,alice-001
Bob Smith,Nail Technician,+1234567891,bob@salon.com,bob-002
Carol White,Massage Therapist,+1234567892,carol@salon.com,carol-003
```

**Required fields:** `name`
**Optional fields:** `specialization`, `phone`, `email`, `api_id`

**Notes:**
- Phone numbers: international format recommended (+country code)
- API ID: custom identifier for integration purposes
- Empty fields allowed (leave blank or use empty quotes)

### Services CSV Template

```csv
title,price_min,price_max,duration,category_id,api_id
Women's Haircut,50,60,60,501,haircut-w
Men's Haircut,35,45,45,501,haircut-m
Hair Coloring,80,150,120,501,color
Manicure,30,40,45,502,manicure
Pedicure,45,60,60,502,pedicure
Swedish Massage,70,90,90,503,massage-sw
```

**Required fields:** `title`, `price_min`, `duration`
**Optional fields:** `price_max`, `category_id`, `api_id`

**Notes:**
- Prices: numeric values (no currency symbols)
- Duration: minutes as integer
- Category ID: use IDs from `onboarding_add_categories` response

### Clients CSV Template

```csv
name,phone,email,surname,comment
Sarah Miller,+1234560001,sarah@example.com,Miller,VIP client
John Davis,+1234560002,john@example.com,Davis,Prefers afternoon appointments
Emma Wilson,,emma@example.com,Wilson,Email contact only
```

**Required fields:** Either `phone` OR `email` (at least one)
**Optional fields:** `surname`, `comment`

**Notes:**
- Deduplication: automatically skips existing phone/email combinations
- Phone format: any format accepted, but international recommended
- Comment: free-text notes about client preferences

## Advanced Features

### Preview Data Before Import

Check data parsing and validation without creating entities:

```typescript
onboarding_preview_data({
  data_type: "staff",
  raw_input: `name,specialization,phone
Alice Johnson,Senior Stylist,+1234567890
Bob Smith,Nail Technician,invalid-phone`
})

// Response: "Preview for 2 staff entries:
//
//           ✓ Row 1: Alice Johnson - Senior Stylist
//             phone: +1234567890
//
//           ✗ Row 2: Bob Smith - Nail Technician
//             Error: phone format invalid: 'invalid-phone'
//
//           Valid entries: 1
//           Invalid entries: 1
//
//           Fix errors before importing with onboarding_add_staff_batch()"
```

### Resume After Error

If an error interrupts the onboarding process:

```typescript
// Later, in a new session
altegio_login({ email: "...", password: "..." })

onboarding_resume({
  company_id: 123456
})

// Response: "Onboarding session resumed for company 123456
//           Current phase: services
//
//           Completed:
//           ✓ categories - 3 entities
//           ✓ staff - 3 entities
//
//           Next steps: Continue with onboarding_add_services_batch()
//           or onboarding_status() for full progress"
```

### Manual Checkpoint

Save progress manually at any point:

```typescript
onboarding_checkpoint({
  company_id: 123456
})

// Response: "Checkpoint saved for company 123456
//           Phase: services
//           Timestamp: 2025-01-29T10:45:30.000Z"
```

### Rollback Specific Phase

Undo a phase and delete created entities:

```typescript
onboarding_rollback_phase({
  company_id: 123456,
  phase_name: "test_bookings"
})

// Response: "Rollback preview for phase: test_bookings
//           Entities to delete: 5 bookings
//           IDs: [301, 302, 303, 304, 305]
//
//           Confirm deletion? This action cannot be undone."

// After confirmation:
// "Successfully rolled back phase: test_bookings
//  Deleted 5 bookings
//  State reset to phase: clients
//  You can now re-run onboarding_create_test_bookings() with different parameters"
```

**Rollback order (reverse dependency):**
1. `test_bookings` (depends on staff, services, clients)
2. `clients` (standalone)
3. `services` (depends on categories)
4. `categories` (standalone)
5. `staff` (standalone)

## Error Handling

### Partial Success

If some entries fail during batch import:

```typescript
onboarding_add_staff_batch({
  company_id: 123456,
  staff_data: [
    { name: "Alice", specialization: "Stylist", phone: "+1234567890" },
    { name: "", specialization: "Invalid" },  // Missing required field
    { name: "Bob", specialization: "Barber", phone: "+1234567891" }
  ]
})

// Response: "Batch import completed with partial success
//           Created: 2 staff members
//           Created IDs: [101, 103]
//
//           Failed entries: 1
//           Row 2 - Error: name is required (empty string provided)
//
//           Checkpoint saved with successfully created entities
//           Fix failed entries and re-run with corrected data"
```

### Network Errors

Automatic checkpoint before error, allowing safe resume:

```typescript
// During import, network timeout occurs
// System automatically saves checkpoint with created IDs before throwing error

// Resume in new session:
onboarding_resume({ company_id: 123456 })
// Response shows which entities were successfully created before error
```

### Rate Limiting

Built-in handling for API rate limits (200 req/min):

```typescript
// Server automatically pauses when rate limit approached
// Progress displayed during large imports:
// "Processing staff batch: 45/100 created (rate limit: waiting 10s...)"
```

## State Management

### State File Location

```
~/.altegio-mcp/onboarding/{company_id}/state.json
```

**Example state file:**
```json
{
  "company_id": 123456,
  "phase": "services",
  "started_at": "2025-01-29T10:30:00.000Z",
  "updated_at": "2025-01-29T10:45:00.000Z",
  "checkpoints": {
    "categories": {
      "completed": true,
      "entity_ids": [501, 502, 503],
      "timestamp": "2025-01-29T10:31:15.000Z"
    },
    "staff": {
      "completed": true,
      "entity_ids": [101, 102, 103],
      "timestamp": "2025-01-29T10:32:45.000Z"
    }
  },
  "conversation_context": {
    "parsed_staff": [...],
    "parsed_services": [...]
  }
}
```

### Multi-Company Isolation

Each company has isolated state directory, allowing parallel onboarding:

```typescript
// Company A onboarding
onboarding_start({ company_id: 111111 })
onboarding_add_staff_batch({ company_id: 111111, ... })

// Company B onboarding (independent)
onboarding_start({ company_id: 222222 })
onboarding_add_staff_batch({ company_id: 222222, ... })

// States saved separately:
// ~/.altegio-mcp/onboarding/111111/state.json
// ~/.altegio-mcp/onboarding/222222/state.json
```

## Complete Workflow Example

Full onboarding from scratch to operational platform:

```typescript
// 1. Login
altegio_login({ email: "owner@salon.com", password: "secure123" })

// 2. Start onboarding
onboarding_start({ company_id: 123456 })

// 3. Create service categories
onboarding_add_categories({
  company_id: 123456,
  categories: [
    { title: "Hair Services", weight: 1 },
    { title: "Nail Services", weight: 2 }
  ]
})
// Note category IDs: [501, 502]

// 4. Import staff from CSV
onboarding_add_staff_batch({
  company_id: 123456,
  staff_data: `name,specialization,phone,email
Alice Johnson,Senior Stylist,+1234567890,alice@salon.com
Bob Smith,Nail Technician,+1234567891,bob@salon.com
Carol White,Manicurist,+1234567892,carol@salon.com`
})
// Created staff IDs: [101, 102, 103]

// 5. Add services
onboarding_add_services_batch({
  company_id: 123456,
  services_data: `title,price_min,price_max,duration,category_id
Women's Haircut,50,60,60,501
Hair Coloring,80,150,120,501
Manicure,30,40,45,502
Pedicure,45,60,60,502`
})
// Created service IDs: [201, 202, 203, 204]

// 6. Import clients
onboarding_import_clients({
  company_id: 123456,
  clients_csv: `name,phone,email,surname
Sarah Miller,+1234560001,sarah@example.com,Miller
John Davis,+1234560002,john@example.com,Davis
Emma Wilson,+1234560003,emma@example.com,Wilson`
})
// Created client IDs: [1001, 1002, 1003]

// 7. Generate test bookings
onboarding_create_test_bookings({
  company_id: 123456,
  count: 5
})
// Created booking IDs: [301, 302, 303, 304, 305]

// 8. Verify completion
onboarding_status({ company_id: 123456 })
// Status: complete
// Total entities: 3 categories, 3 staff, 4 services, 3 clients, 5 bookings
```

**Time estimate:** 5-10 minutes for typical salon setup (vs 30+ minutes manual entry)

## Troubleshooting

### Error: "Authentication required"
**Solution:** Run `altegio_login()` first

### Error: "Category ID not found"
**Solution:** Run `onboarding_add_categories()` before `onboarding_add_services_batch()`

### Error: "No staff or services available for test bookings"
**Solution:** Create at least 1 staff member and 1 service before generating test bookings

### CSV parsing fails with quoted fields
**Solution:** Use double quotes for fields containing commas:
```csv
name,comment
Alice,"Specializes in coloring, cutting, and styling"
Bob,"Prefers morning shifts, available Mon-Fri"
```

### Rate limit errors during large imports
**Solution:** Import in smaller batches (50-100 rows at a time) or let the system auto-retry after delay

## API Reference

### Control Tools

**`onboarding_start(company_id)`**
- Initialize new onboarding session
- Creates state file with `phase: "init"`
- Returns: session ID and next steps

**`onboarding_resume(company_id)`**
- Load existing state from file
- Display progress summary
- Suggest next action based on current phase

**`onboarding_status(company_id)`**
- Show current phase, completed steps, entity counts
- Display checkpoint timestamps
- Read-only, no state changes

### Data Input Tools

**`onboarding_add_categories(company_id, categories)`**
- Create service category hierarchy
- Input: `[{title, api_id?, weight?}, ...]`
- Returns: created category IDs

**`onboarding_add_staff_batch(company_id, staff_data)`**
- Bulk add staff from JSON array or CSV string
- Required: `name`
- Optional: `specialization`, `phone`, `email`, `api_id`

**`onboarding_add_services_batch(company_id, services_data)`**
- Bulk add services from JSON array or CSV string
- Required: `title`, `price_min`, `duration`
- Optional: `price_max`, `category_id`, `api_id`

**`onboarding_import_clients(company_id, clients_csv)`**
- Import client database from CSV
- Required: `name` + (`phone` OR `email`)
- Optional: `surname`, `comment`
- Deduplicates by phone/email

**`onboarding_create_test_bookings(company_id, count?)`**
- Generate sample appointments (default: 5)
- Requires: at least 1 staff + 1 service
- Distributes across next 7 days

### Utility Tools

**`onboarding_preview_data(data_type, raw_input)`**
- Parse and validate without creating entities
- Types: 'staff', 'services', 'clients'
- Shows structured preview with validation errors

**`onboarding_checkpoint(company_id)`**
- Manual save point (auto-checkpoints also happen)
- Returns: checkpoint ID and timestamp

**`onboarding_rollback_phase(company_id, phase_name)`**
- Delete entities from specified phase
- Reset state to previous checkpoint
- Confirmation required for destructive action

## Best Practices

1. **Always preview large datasets** before importing:
   ```typescript
   onboarding_preview_data({ data_type: "staff", raw_input: csv_data })
   ```

2. **Create categories first** before services (services depend on category IDs)

3. **Use meaningful api_ids** for external integrations:
   ```typescript
   { title: "Haircut", api_id: "service-haircut-001" }
   ```

4. **Check status regularly** during multi-step onboarding:
   ```typescript
   onboarding_status({ company_id: 123456 })
   ```

5. **Test with small batches** before full import (10-20 rows)

6. **Save CSV templates** for future use or additional locations

7. **Use rollback for corrections** rather than manual deletion:
   ```typescript
   onboarding_rollback_phase({ company_id: 123456, phase_name: "staff" })
   ```

## Next Steps

After completing onboarding:

1. **Verify data:** Use existing tools to check created entities
   ```typescript
   get_staff({ company_id: 123456 })
   get_services({ company_id: 123456 })
   get_bookings({ company_id: 123456 })
   ```

2. **Customize settings:** Update staff schedules, service configurations

3. **Start operations:** Create real bookings using `create_booking()`

4. **Monitor performance:** Check booking patterns, popular services

5. **Scale as needed:** Add more staff, services, or locations using batch tools

## Support

- **Documentation:** Full MCP server docs in [README.md](../README.md)
- **API Reference:** [developer.alteg.io/api](https://developer.alteg.io/api)
- **Issues:** [GitHub Issues](https://github.com/altegio/altegio-pro-mcp/issues)
