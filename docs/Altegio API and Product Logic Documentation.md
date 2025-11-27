# Technical Specification and Product Logic Description of Altegio for MCP Server Development

## Introduction


This document provides a comprehensive technical description of the architecture, data model, and business logic of the Altegio platform. Its primary purpose is to serve as a fundamental guide and set of instructions for an AI development agent tasked with creating the backend for a multi-channel platform (MCP).
The documentation is based on a systematic analysis of the official Altegio REST API documentation and contextual information from the product's knowledge base. The document details key entities, their relationships, and core business processes, providing the necessary depth of understanding for the accurate and efficient implementation of an MCP server. The structure of the document is designed to be as clear and unambiguous as possible for automated interpretation and subsequent code generation.

## Part 1: Key Architectural Concepts and Data Model


This section lays the foundation for understanding the Altegio ecosystem. Mastering these concepts is a prerequisite before implementing any business logic. Altegio's architecture is built on a clear hierarchy of entities that define the data structure, access rights, and the logic of business operations.

### 1.1. Business Hierarchy: Chains, Companies, and Resources


At the core of Altegio lies a three-tiered hierarchical structure that models business organization from the macro to the micro level. Understanding this hierarchy is crucial as it defines the scope of data and the context for executing API requests. 1

- **Chain:** The highest level of the hierarchy. The Location Chain entity (endpoint group 39) represents a brand, franchise, or a group of related companies. A chain unites multiple branches under a single management, allowing for the application of common settings, services, and marketing promotions. Operations at the chain level, such as creating a chain-wide promotion (postCreate a Chain Promotion, group 46) or retrieving a list of chain service categories (getGet a list of chain service categories, group 11), affect all its constituent branches.
- **Location:** The middle level of the hierarchy. The Company entity (endpoint group 10) represents a single business unit or physical location (e.g., a beauty salon, clinic, or fitness studio). Most operational data, such as client appointments, employee schedules, and financial transactions, are tied to a specific company. The company is the primary operational context for most API calls.
- **Entities:** The lowest level of the hierarchy. Such as Service, Team Member (Employee/Professional), Client, User, Resource, Membership etc. Represents a specific physical or logical object within a location or Chain.


This structure gives rise to a fundamental architectural principle: **contextual data scope and inheritance of settings**. Entities created at the chain level function as templates or defaults that are available to all child companies. For example, a chain-wide promotion will be valid in any company within the chain. At the same time, a company can have its own local entities (e.g., a promotion valid only in that branch) that override or supplement the chain-level ones.
For the MCP server, this means it must be "context-aware." When performing any operation, whether retrieving a list of available services or validating a promo code, the server must clearly understand whether it is operating in the context of a chain or an individual company. This may require implementing multi-level API queries: first, the system checks for company-specific data or settings, and only if they are absent does it query the chain-level data. This logic must be embedded in the core architecture of the MCP for it to work correctly with multi-location structures.

### 1.2. System Actors: Users, Employees, and Clients


The Altegio platform operates with several types of actors, each with its own role, data set, and access rights. The API strictly delineates these entities, indicating their fundamental difference in the data model. 1

- **Users:** These are actors who manage the system from within—administrators, managers, marketers. A User (groups 1, 13, 21) has credentials to log into the system, is assigned a specific role (getGetting a list of user roles), and a set of rights (getGet a list of rights) that determine their access to various back-office functions. Users manage company settings, staff, finances, etc.
- **Employees:** These are the service providers—stylists, trainers, doctors. An Employee (group 48) is a key operational unit. An employee has a work schedule (getGet an employee's schedule, group 51), is linked to specific services they can perform (postLinking an Employee to a Provided Service, group 12), and is the subject of payroll calculations (getSearch payroll calculations of an employee, group 64). Typically, each Employee is also a User with limited rights (e.g., to view their own schedule).
- **Clients:** These are the end consumers of services. A Client (groups 14, 49) has a profile with contact information, visit history, participation in loyalty programs, etc. It is important to distinguish between a client at the company level and a **Chain Client** (group 49). A chain client has a single profile that is accessible across all companies in the chain, enabling seamless loyalty programs and a complete history of the client's interactions with the brand.
- **Online Booking Users:** This is a subtype of Client who has registered in the online booking system and created credentials (login/password) to self-manage their appointments (putOnline Booking User Password Update, group 9). This state essentially "activates" a personal account for the client, where they can view their future and past visits (getGet User Appointments, group 47) and cancel them.


The actor management system in Altegio is not just a list of users, but a complex Identity and Access Management (IAM) and Customer Relationship Management (CRM) system. The relationships between these actors can be non-trivial. For example, the same person can be a User (with admin rights), an Employee (providing services), and a Client (booking services with another specialist).
Therefore, the MCP server cannot use a simplified, flat user model. It must implement a data model capable of representing these different actor types and their complex interrelationships. When authenticating a user, the system must identify all their roles (User, Employee, etc.) and provide the appropriate interface and set of permissions. The server must also correctly handle the process of "promoting" a regular Client to an Online Booking User upon registration for a personal account.

### 1.3. Service and Product Catalog


This component defines *what* the business sells and is the foundation for all booking and sales operations.

- **Services:** This is the primary offering of the business. Services (group 12) have attributes such as name, description, cost, and duration. They are organized into Service Categories (group 11) for ease of navigation and management. A key aspect is that services do not exist in a vacuum. They must be explicitly linked to the employees who are authorized to perform them (postLinking an Employee to a Provided Service). This link can have unique parameters, such as an individual duration or cost for a service with a specific specialist (putUpdating Employee Service Link Settings).
- **Products:** These are retail goods that the business sells in addition to services (e.g., cosmetics, accessories). Products (group 66) are organized into Product Categories (group 32) and are managed through an inventory system.
- **Bill of Materials and Consumables:** This functionality (group 33) is a critical link between services and inventory management. It allows for linking a list of Products (consumables) to each service. For example, for the "Hair Coloring" service, you can specify that it consumes a certain amount of dye and oxidant. When a visit with this service is completed, the system automatically deducts the specified consumables from the inventory (putUpdate Consumables for the Appointment-Service Association).


Thus, services and products are not isolated entities. They are closely interconnected through the consumables system, forming a three-way relationship "Service-Product-Inventory" that is central to the platform's financial and inventory accounting. A single client visit can trigger changes in all three domains: a record of the service provided, a financial transaction for its payment, and a product transaction for the deduction of consumables.
When developing the MCP server, a "sale" cannot be treated as a simple atomic event. When processing a completed visit, a comprehensive workflow must be implemented that: a) finalizes the service record; b) processes the payment; c) calls the necessary endpoints to update inventory levels based on the service's bill of materials. This requires understanding the entire transaction as a whole, not just the part related to the appointment.

### 1.4. Scheduling and Booking Model


This is the core of the system's operational logic, determining the availability of services for booking. The model is built on several levels of abstraction. 1

- **Work Schedule:** The base layer, defining an employee's working hours (getGet an employee's schedule, group 51). This is a static schedule that sets the general framework of availability (e.g., "Stylist Anna works from 9:00 to 18:00, Monday to Friday").
- **Sessions:** The work schedule is "sliced" into specific time slots available for booking—Sessions (group 52). A session is not just a time interval, but an available slot for a specific employee and a specific service, taking its duration into account. For example, within a stylist's workday, the system generates 60-minute sessions for one service and 30-minute sessions for another.
- **Appointment / Entry:** When a client books a session, an Appointment or Entry is created (groups 15, 16). This entity secures the booking for a specific client and makes the corresponding session unavailable to others.
- **Group Events:** Unlike individual appointments, Group Events (group 18) are pre-planned activities (e.g., masterclasses, group workouts) with a fixed time and a limited number of spots. Clients book one of the available spots within the event rather than an individual session.


A key feature of the system is that calculating availability for online booking is not a simple search for free time in a calendar. The list of available sessions that a client sees is the result of a **dynamic, real-time calculation**. This calculation considers the intersection of multiple factors:

1. The employee's base Work Schedule.
1. The list of services this employee can perform (Employee-Service Link) and their individual durations.
1. Already existing Appointments in the schedule.
1. The availability of necessary Resources (e.g., a room or a machine).


The getGet a List of Sessions Available for Booking endpoint (group 7) does not simply read a static table; it performs this complex calculation on the Altegio server-side, combining all the listed constraints.
For the AI agent, this means it should not attempt to replicate this complex availability calculation logic on its own side. Attempting to do so will lead to errors and data desynchronization. To correctly implement the process of finding and displaying available slots, the MCP server must strictly follow the sequence of API calls described in the Online appointment section (group 7) and rely entirely on the results returned by the Altegio backend.

## Part 2: Core Business Scenarios (Key Workflows)


This section provides a detailed, step-by-step description of the most business-critical user scenarios. The implementation of these processes in the MCP server must be precise and adhere to the outlined logic.

### 2.1. Client Online Booking Lifecycle


This process describes the client's journey from finding an available time slot to confirming the appointment. It is primarily defined by endpoints from the Online appointment (group 7) and Online Booking Users (group 9) sections. 1
**1. Discovery Phase (Finding an available slot):**

- **Step 1.1:** The client selects the desired service (or multiple services). The server requests a list of services available for online booking via getGet a List of Services Available for Booking.
- **Step 1.2:** The client selects a specialist or the "Any Specialist" option. The server requests a list of available employees via getGet a list of employees available for booking.
- **Step 1.3:** The client selects a date. The server requests a list of dates that have at least one available slot for the chosen service-employee combination using getGet a list of dates available for booking.
- **Step 1.4:** Based on all previous selections, the server requests and displays the specific time slots (sessions) available for booking to the client using the getGet a List of Sessions Available for Booking call.


**2. Execution Phase (Creating the booking):**

- **Step 2.1:** The client selects a suitable time slot.
- **Step 2.2:** The server requests the client's contact details (name, phone, email). Phone number verification may be required by sending an SMS code using postSend SMS verification code for phone number.
- **Step 2.3 (Critically Important):** Before creating the appointment, the server must perform a "pre-check" of the booking possibility. To do this, it sends a request to the postCheck Booking Options endpoint, passing all the information about the selected session (service, employee, date, time). This call verifies that the slot is still available and has not been booked by another client during the selection process.
- **Step 2.4:** Only after receiving a successful response from postCheck Booking Options does the server execute the final request to create the appointment by calling postCreate a Session Entry. This call definitively confirms the booking in the system.


**3. Management Phase (After booking):**

- **Step 3.1:** If the client is authenticated (is an Online Booking User), they can view a list of their upcoming appointments via getGet User Appointments (group 47).
- **Step 3.2:** The client can cancel their appointment through their personal account, which initiates a call to delDelete User Appointment (group 8).


The online booking process should be viewed not as a single action, but as a **transactional workflow managed by a state machine**. The postCheck Booking Options endpoint plays a key role in this process. It functions as a "prepare to commit" step in a two-phase transaction. This mechanism prevents race conditions where two clients simultaneously attempt to book the same slot. The system verifies the slot's availability at the last moment before creating the appointment and possibly "locks" it temporarily.
The MCP server **must** implement this two-step validation and creation process. Skipping the postCheck Booking Options call and proceeding directly to appointment creation (postCreate a Session Entry) is unacceptable. This would lead to a high rate of failed bookings and, consequently, a negative user experience. The correct logic must be: Check possibility (Check) -> (If successful) -> Create appointment (Create).

### 2.2. In-Branch Visit and Payment Lifecycle


This scenario describes the process that occurs when a client physically arrives at the branch to receive a service. It involves converting a preliminary Appointment into an active Visit and the subsequent payment process. This workflow utilizes endpoints from multiple sections: Appointments (16), Visits (17), Application of loyalty in a visit (28), Checkout (22), Financial Transactions (26), and Sale operation (55). 1
**1. Client Arrival and Status Change:**

- **Step 1.1:** The administrator finds the client's Appointment in the journal for the current day.
- **Step 1.2:** When the client confirms their arrival, the Appointment is converted into an active Visit. Although the API documentation does not have a separate endpoint for this action, it logically means that all subsequent operations (adding services, payment) will be performed in the context of a Visit ID. The Visit entity represents the current, ongoing service session. The appointment status changes to "Client Arrived."


**2. Managing Services and Sales within the Visit:**

- **Step 2.1:** During the visit, the client may request additional services or purchase retail products. The administrator adds them to the current visit, which corresponds to modifying the Visit object (e.g., via putEdit Visit).
- **Step 2.2:** If consumables were used for the services provided, the system tracks their deduction in connection with this visit (putUpdate Consumables for the Appointment-Service Association).


**3. Calculation and Payment (Checkout):**

- **Step 3.1:** The administrator initiates the payment process for the completed Visit.
- **Step 3.2 (Applying Loyalty):** This is the first stage of the calculation. The server can apply promotional discounts to the visit (postApply a Discount Promotion in a Visit), redeem points from a loyalty card (postApply Deduction from the Loyalty Card in the Visit), or use a membership.
- **Step 3.3 (Processing Payment):** After applying all discounts and bonuses, the remaining amount is paid by the client. The server processes this payment using endpoints from the Sale operation section (group 55), specifying the payment method (cash, card, etc.) and the cash register ID (cash_register_id, obtained from getGet company cash registers). This operation creates one or more Financial Transaction entities.
- **Step 3.4 (Finalization):** After full payment, the Visit status is changed to "Client Left" (completed), and all related financial and inventory transactions are permanently recorded in the system.


The Visit entity is not just a "fulfilled appointment" but a **central orchestrator object** for the entire in-branch transaction. It functions as a "shopping cart" or "session context" that aggregates all services rendered, products sold, loyalty programs applied, and payments made within a single auditable event. While an Appointment is a simple schedule entry (who, what, when), a Visit is a rich, dynamic object. The API allows retrieving transactions by visit (getGet loyalty transactions by visit, getGet Transactions by Visit or Appointment ID), which confirms its central role. The Visit ID acts as a foreign key that links records from different tables: services, products, loyalty points, and financial payments.
Consequently, the internal state management logic in the MCP server must be built around the Visit object. When a client arrives, the server should create a local representation of a "visit context." All subsequent actions (adding a product, applying a discount) must be performed within this context. The final payment process orchestrates calls to the loyalty, finance, and inventory APIs, using the Visit ID as a unified identifier for all operations.

## Part 3: Ancillary Systems and Supporting Logic


This section covers other important functional blocks of the Altegio platform that provide its full range of capabilities and must be considered during the development of the MCP server.

### 3.1. Loyalty and Customer Retention


Altegio provides a multi-functional system for increasing customer loyalty, described in endpoint groups 27, 28, 46, 57, and 58. It includes several interconnected mechanisms 1:

- **Loyalty Cards:** Bonus or discount cards where points can be accumulated or client discount information is stored.
- **Promotions:** Marketing campaigns that can be active at the entire chain level (Chain Promotion) or at an individual company level.
- **Memberships:** A product that a client purchases in advance, which entitles them to a certain number of services or discounts for a specified period.
- **Gift Cards:** Certificates with a prepaid value that can be used to pay for services and products.
- **Client personal accounts:** An internal client deposit (store credit) to which funds can be added and used for payment.


The API architecture for applying loyalty (section 28, Application of loyalty in a visit) shows that loyalty programs are not just another payment method. They are **calculation modifiers that are applied before the final payment stage**. The existence of endpoints not only for applying (postApply...) but also for canceling (postCancel...) discounts and redemptions within a single visit indicates an "intermediate calculation stage." At this stage, various modifiers are applied to the visit, but the final total is not yet fixed.
This can be visualized as a sequence of actions during checkout:

1. The base cost of all services and products in the visit is calculated.
1. All available and client-selected loyalty elements (promotional discount, bonus point redemption, use of a membership visit) are applied sequentially. Each such application is reversible (cancel) and changes the intermediate amount due.
1. After all modifiers have been applied, the final, total amount is calculated.
1. It is this final amount that is passed to the payment processing stage (cash, card, etc.).


Therefore, the payment interface and logic in the MCP server must be multi-step. First, there should be an "Apply Loyalty" stage, where the operator (administrator) calls various Apply... endpoints, and the interface recalculates the amount due in real-time. Only after the client and operator have agreed on all discounts does the system move to the final "Payment" stage, where irreversible financial transactions are created and the visit is closed.

### 3.2. Financial and Inventory Management


This block covers back-office operations for accounting for funds and product stock. Key API sections are Financial Transactions (26), Inventories (23), Product Transactions (34), Inventory Operations (35), and Z-Report (40). The system is designed to track every financial movement and every unit of product. 1
The central principle of this system is the **dualism of ledgers**. In Altegio, there are two parallel but related ledgers:

- **Financial Transactions Ledger (Financial Transactions):** Records any movement of funds (e.g., +$50 from a service sale, -$100 for purchasing supplies).
- **Product Transactions Ledger (Product Transactions):** Records any movement of goods and materials (e.g., -1 unit of shampoo upon sale, +10 units of dye upon delivery from a supplier).


A single business event, such as the retail sale of a product, generates entries in **both** ledgers. For example, selling a shampoo for $10 will create a financial transaction of +$10 and a product transaction of -1 unit. This double-entry system allows for full reconciliation and auditing, enabling the comparison of financial reports with actual changes in inventory. The endpoints for inventory documents (group 36, Inventory Operations Documents) explicitly support this principle, allowing retrieval of both financial (getGet document financial transactions) and product (getGet Product Transactions of a Document) transactions associated with a single document (e.g., a purchase invoice).
When developing the MCP server, the AI agent must ensure that all operations affecting both money and goods correctly create entries in both ledgers. For example, a product sale function must include logic to create a financial transaction for the payment and a product transaction for the inventory deduction. Similarly, a product return operation must create reversing entries in both accounting systems.

## Appendix: Mapping Business Functions to API Endpoints


This table serves as a reference guide for the AI agent, designed to quickly map the business tasks described in this document to specific, executable API calls. This eliminates ambiguity and accelerates the development process by providing a direct path from a business requirement to its technical implementation.

## Conclusion


The Altegio platform is a complex, multi-layered system with deeply elaborated business logic. For the successful development of an MCP server based on it, the AI agent must strictly adhere to the key architectural principles outlined in this document.
The following aspects are critically important for implementation:

1. **Context Awareness:** All operations must be performed with a clear understanding of the current context—whether at the Chain or individual Company level—which directly affects data availability and applied settings.
1. **Central Role of the Visit Entity:** When implementing in-branch service logic, the Visit must be treated as the main orchestrator object, aggregating all transaction components from services to payments.
1. **Transactional Processes:** System-state-changing processes, such as online booking, must be implemented as multi-step transactions with mandatory pre-validation stages (Check -> Create) to ensure data integrity and avoid race conditions.
1. **Dualism of Financial and Inventory Accounting:** Operations affecting both funds and product stock must generate corresponding entries in both system ledgers (Financial Transactions and Product Transactions) to ensure complete and accurate accounting.


Strict adherence to these principles and the use of the provided "business function -> API endpoint" mapping table will enable the creation of a reliable, efficient, and logically correct MCP server, fully integrated with the Altegio ecosystem.