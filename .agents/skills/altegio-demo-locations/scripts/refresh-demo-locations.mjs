#!/usr/bin/env node

import { HostedMcpSession } from './mcp-client.mjs';

const DAY_MS = 86_400_000;
const ANCHOR = new Date(
  `${process.env.DEMO_ANCHOR_DATE || new Date().toISOString().slice(0, 10)}T12:00:00Z`
);
const APPLY = process.argv.includes('--apply');
const requestedId = Number(
  process.argv.find((arg) => arg.startsWith('--location='))?.split('=')[1] || 0
);
const HISTORY_DAYS = 45;
const FUTURE_DAYS = 45;
const SCHEDULE_PAST_DAYS = 60;
const SCHEDULE_FUTURE_DAYS = 60;

const profiles = [
  {
    id: 4564,
    title: 'Ateliér Vltava | Praha [TEST]',
    timeZone: 'Europe/Prague',
    closedWeekdays: [0],
    dailyMinimum: {
      scheduledStaff: 4,
      pastAppointments: 10,
      futureAppointments: 6,
    },
    location: {
      country_id: 13,
      city_id: 589,
      address: 'Dlouhá 24, Praha 1',
      zip: '110 00',
      coordinate_lat: 50.0892,
      coordinate_lon: 14.4234,
      short_descr: 'Kadeřnictví, nehty a kosmetika v centru Prahy',
      description:
        '<p>Moderní beauty studio v centru Prahy. Střihy, barvení, nehtová péče a kosmetika v klidné atmosféře.</p>',
      site: 'atelier-vltava.example',
      business_type_id: 4,
    },
    bookingForm: {
      title: 'Online rezervace | Ateliér Vltava',
      description: 'Rezervujte si termín u našeho týmu v centru Prahy.',
    },
    providerPosition: 'Specialista',
    receptionPosition: 'Recepce',
    providerBio:
      'Pracuje pečlivě, vysvětlí následnou péči a pomůže vybrat vhodnou službu.',
    receptionBio: 'Pomáhá týmu a klientům s rezervacemi.',
    categories: [
      'Vlasy – dámské',
      'Vlasy – pánské',
      'Barvení',
      'Nehty',
      'Kosmetika',
    ],
    staff: [
      {
        key: 'jana',
        name: 'Jana Dvořáková',
        specialization: 'Kadeřnice',
        weight: 100,
        daysOff: [0, 1],
        slots: [
          ['09:00', '13:00'],
          ['14:00', '18:00'],
        ],
        target: 165,
      },
      {
        key: 'petra',
        name: 'Petra Svobodová',
        specialization: 'Koloristka',
        weight: 90,
        daysOff: [0, 2],
        slots: [
          ['10:00', '14:00'],
          ['15:00', '19:00'],
        ],
        target: 135,
      },
      {
        key: 'tereza',
        name: 'Tereza Nováková',
        specialization: 'Kadeřnice',
        weight: 80,
        daysOff: [0, 3],
        slots: [
          ['11:00', '15:00'],
          ['16:00', '20:00'],
        ],
        target: 110,
      },
      {
        key: 'martin',
        name: 'Martin Horák',
        specialization: 'Pánský kadeřník',
        weight: 70,
        daysOff: [0, 4],
        slots: [
          ['09:00', '13:00'],
          ['14:00', '18:00'],
        ],
        target: 90,
      },
      {
        key: 'kristyna',
        name: 'Kristýna Marková',
        specialization: 'Manikérka a pedikérka',
        weight: 60,
        daysOff: [0, 1],
        slots: [
          ['10:00', '14:00'],
          ['15:00', '19:00'],
        ],
        target: 75,
      },
      {
        key: 'lucie',
        name: 'Lucie Procházková',
        specialization: 'Kosmetička',
        weight: 50,
        daysOff: [0, 2],
        slots: [
          ['11:00', '15:00'],
          ['16:00', '20:00'],
        ],
        target: 65,
      },
      {
        key: 'reception',
        name: 'Kateřina Veselá',
        specialization: 'Recepce',
        weight: 10,
        provider: false,
      },
    ],
    services: [
      [
        'damsky-strih',
        'Dámský střih',
        'Vlasy – dámské',
        790,
        1090,
        3600,
        ['jana', 'petra', 'tereza'],
        'Střih, mytí, péče a foukaná.',
      ],
      [
        'foukana',
        'Foukaná',
        'Vlasy – dámské',
        550,
        750,
        2700,
        ['jana', 'petra', 'tereza'],
        'Mytí, styling a foukaná podle délky vlasů.',
      ],
      [
        'uces',
        'Společenský účes',
        'Vlasy – dámské',
        1200,
        1800,
        5400,
        ['jana', 'tereza'],
        'Účes pro svatbu, ples nebo slavnostní večer.',
      ],
      [
        'pansky-strih',
        'Pánský střih',
        'Vlasy – pánské',
        490,
        490,
        2700,
        ['martin', 'jana'],
        'Klasický nebo moderní střih včetně stylingu.',
      ],
      [
        'strojek',
        'Střih strojkem',
        'Vlasy – pánské',
        320,
        320,
        1800,
        ['martin', 'jana'],
        'Rychlý precizní střih strojkem.',
      ],
      [
        'barveni',
        'Barvení – jeden odstín',
        'Barvení',
        1350,
        2100,
        7200,
        ['petra', 'tereza'],
        'Barvení, péče a závěrečný styling.',
      ],
      [
        'balayage',
        'Melír / balayage',
        'Barvení',
        2200,
        3900,
        10800,
        ['petra'],
        'Konzultace, zesvětlení, tónování a péče.',
      ],
      [
        'tonovani',
        'Tónování',
        'Barvení',
        900,
        1300,
        5400,
        ['petra', 'tereza'],
        'Oživení odstínu a lesku vlasů.',
      ],
      [
        'manikura',
        'Manikúra',
        'Nehty',
        550,
        550,
        2700,
        ['kristyna'],
        'Klasická manikúra a péče o nehty.',
      ],
      [
        'gel-lak',
        'Gel lak',
        'Nehty',
        790,
        790,
        3600,
        ['kristyna'],
        'Manikúra s dlouhotrvajícím gel lakem.',
      ],
      [
        'pedikura',
        'Pedikúra',
        'Nehty',
        850,
        850,
        3600,
        ['kristyna'],
        'Kompletní pedikúra a péče o chodidla.',
      ],
      [
        'plet',
        'Kosmetické ošetření pleti',
        'Kosmetika',
        1250,
        1250,
        4500,
        ['lucie'],
        'Diagnostika, čištění, maska a hydratace.',
      ],
      [
        'masaz-obliceje',
        'Masáž obličeje',
        'Kosmetika',
        650,
        650,
        1800,
        ['lucie'],
        'Uvolňující masáž obličeje, krku a dekoltu.',
      ],
    ],
    clientLocale: {
      first: [
        'Anna',
        'Eliška',
        'Tereza',
        'Lucie',
        'Karolína',
        'Barbora',
        'Veronika',
        'Adéla',
      ],
      last: [
        'Nováková',
        'Svobodová',
        'Dvořáková',
        'Černá',
        'Procházková',
        'Veselá',
        'Horáková',
        'Králová',
      ],
      phonePrefix: '42060150',
      emailDomain: 'example.cz',
    },
  },
  {
    id: 720441,
    title: 'Brzytwa | Kraków [TEST]',
    timeZone: 'Europe/Warsaw',
    closedWeekdays: [0],
    dailyMinimum: {
      scheduledStaff: 3,
      pastAppointments: 6,
      futureAppointments: 5,
    },
    location: {
      country_id: 12,
      city_id: 1446,
      address: 'Szewska 18, Stare Miasto',
      zip: '31-009',
      coordinate_lat: 50.0631,
      coordinate_lon: 19.9346,
      short_descr: 'Barbershop w sercu Krakowa',
      description:
        '<p>Klasyczny krakowski barbershop: precyzyjne strzyżenie, pielęgnacja brody i męska koloryzacja.</p>',
      site: 'brzytwa-i-brod.example',
      business_type_id: 4,
    },
    bookingForm: {
      title: 'Rezerwacja online | Brzytwa i Bród',
      description: 'Wybierz barbera i dogodny termin w centrum Krakowa.',
    },
    providerPosition: 'Barber',
    receptionPosition: 'Recepcja',
    providerBio:
      'Pracuje precyzyjnie, objaśnia pielęgnację domową i pomaga wybrać usługę.',
    receptionBio: 'Pomaga zespołowi i klientom w rezerwacjach.',
    categories: ['Strzyżenie', 'Broda i twarz', 'Pakiety', 'Koloryzacja'],
    staff: [
      {
        key: 'mateusz',
        name: 'Mateusz Zieliński',
        specialization: 'Barber',
        weight: 100,
        daysOff: [0, 1],
        slots: [
          ['09:00', '13:00'],
          ['14:00', '18:00'],
        ],
        target: 170,
      },
      {
        key: 'bartosz',
        name: 'Bartosz Kowalczyk',
        specialization: 'Barber',
        weight: 90,
        daysOff: [0, 2],
        slots: [
          ['10:00', '14:00'],
          ['15:00', '19:00'],
        ],
        target: 135,
      },
      {
        key: 'piotr',
        name: 'Piotr Lewandowski',
        specialization: 'Senior Barber',
        weight: 80,
        daysOff: [0, 3],
        slots: [
          ['11:00', '15:00'],
          ['16:00', '20:00'],
        ],
        target: 105,
      },
      {
        key: 'kacper',
        name: 'Kacper Wiśniewski',
        specialization: 'Senior Barber',
        weight: 70,
        daysOff: [0, 4],
        slots: [
          ['10:00', '14:00'],
          ['15:00', '19:00'],
        ],
        target: 80,
      },
      {
        key: 'reception',
        name: 'Ola Kamińska',
        specialization: 'Recepcja',
        weight: 10,
        provider: false,
      },
    ],
    services: [
      [
        'klasyczne',
        'Strzyżenie klasyczne',
        'Strzyżenie',
        80,
        100,
        2700,
        ['mateusz', 'bartosz', 'piotr', 'kacper'],
        'Konsultacja, mycie, strzyżenie i stylizacja.',
      ],
      [
        'maszynka',
        'Strzyżenie maszynką',
        'Strzyżenie',
        55,
        55,
        1800,
        ['mateusz', 'bartosz', 'piotr', 'kacper'],
        'Precyzyjne strzyżenie maszynką.',
      ],
      [
        'dziecko',
        'Strzyżenie dziecięce',
        'Strzyżenie',
        65,
        65,
        2400,
        ['bartosz', 'piotr'],
        'Strzyżenie dla chłopców do 12 lat.',
      ],
      [
        'broda',
        'Trymowanie brody',
        'Broda i twarz',
        50,
        50,
        1800,
        ['mateusz', 'bartosz', 'piotr', 'kacper'],
        'Kontur, trymowanie i pielęgnacja brody.',
      ],
      [
        'brzytwa',
        'Golenie brzytwą',
        'Broda i twarz',
        70,
        70,
        2400,
        ['mateusz', 'piotr', 'kacper'],
        'Klasyczne golenie z gorącym ręcznikiem.',
      ],
      [
        'rytual',
        'Królewski rytuał brody',
        'Broda i twarz',
        90,
        90,
        2700,
        ['mateusz', 'piotr', 'kacper'],
        'Gorący ręcznik, olejek i pełna pielęgnacja.',
      ],
      [
        'combo',
        'Włosy + broda',
        'Pakiety',
        120,
        140,
        4500,
        ['mateusz', 'bartosz', 'piotr', 'kacper'],
        'Kompletny serwis włosów i brody.',
      ],
      [
        'ojciec-syn',
        'Ojciec + syn',
        'Pakiety',
        140,
        160,
        5400,
        ['bartosz'],
        'Dwa strzyżenia podczas jednej wizyty.',
      ],
      [
        'siwizna',
        'Kamuflaż siwizny',
        'Koloryzacja',
        85,
        85,
        2400,
        ['kacper'],
        'Naturalny kamuflaż siwych włosów lub brody.',
      ],
      [
        'kolor',
        'Koloryzacja włosów',
        'Koloryzacja',
        150,
        220,
        5400,
        ['kacper'],
        'Męska koloryzacja dobrana do typu urody.',
      ],
    ],
    clientLocale: {
      first: [
        'Jan',
        'Michał',
        'Krzysztof',
        'Paweł',
        'Tomasz',
        'Jakub',
        'Adam',
        'Marcin',
      ],
      last: [
        'Nowak',
        'Kowalski',
        'Wiśniewski',
        'Wójcik',
        'Kamiński',
        'Lewandowski',
        'Zieliński',
        'Mazur',
      ],
      phonePrefix: '4850060',
      emailDomain: 'example.pl',
    },
  },
  {
    id: 703092,
    title: 'VONA beauty space | Львів [TEST]',
    timeZone: 'Europe/Kyiv',
    closedWeekdays: [],
    dailyMinimum: {
      scheduledStaff: 2,
      pastAppointments: 5,
      futureAppointments: 4,
    },
    location: {
      country_id: 4,
      city_id: 100,
      address: 'вул. Вірменська, 15, Львів',
      zip: '79008',
      coordinate_lat: 49.8435,
      coordinate_lon: 24.0316,
      short_descr:
        'Студія волосся, нігтів і догляду за обличчям у центрі Львова',
      description:
        '<p>Сучасний beauty-простір у серці Львова. Стрижки, складне фарбування, нігтьовий сервіс і дбайливий догляд за обличчям.</p>',
      site: 'vona-lviv.example',
      business_type_id: 4,
    },
    bookingForm: {
      title: 'Онлайн-запис | VONA Львів',
      description: 'Оберіть послугу, майстриню або майстра та зручний час.',
    },
    providerPosition: 'Майстер',
    receptionPosition: 'Адміністратор',
    providerBio:
      'Працює уважно, пояснює домашній догляд і допомагає обрати послугу.',
    receptionBio: 'Допомагає команді та клієнтам із записами.',
    legacyStaffToDelete: ['Татьяна Иванова', 'Сотрудник 1'],
    demoStaffToRemove: ['Софія Мельник', 'Наталія Шевчук', 'Андрій Левицький'],
    demoServicesToRemove: ['Чоловіча стрижка', 'Дитяча стрижка'],
    categories: [
      'Перукарські послуги',
      'Колористика',
      'Нігтьовий сервіс',
      'Догляд за обличчям',
    ],
    staff: [
      {
        key: 'maria',
        name: 'Марія Коваль',
        specialization: 'Стилістка-колористка',
        weight: 100,
        daysOff: [],
        slots: [
          ['10:00', '14:00'],
          ['15:00', '19:00'],
        ],
        target: 195,
      },
      {
        key: 'olena',
        name: 'Олена Бойко',
        specialization: 'Майстриня нігтьового сервісу та естетистка',
        weight: 70,
        daysOff: [],
        slots: [
          ['11:00', '15:00'],
          ['16:00', '20:00'],
        ],
        target: 135,
      },
      {
        key: 'reception',
        name: 'Ірина Савчук',
        specialization: 'Адміністраторка',
        weight: 10,
        provider: false,
      },
    ],
    services: [
      [
        'women-cut',
        'Жіноча стрижка',
        'Перукарські послуги',
        850,
        1100,
        3600,
        ['maria'],
        'Консультація, миття, стрижка та укладка.',
      ],
      [
        'styling',
        'Укладка',
        'Перукарські послуги',
        600,
        800,
        2700,
        ['maria'],
        'Щоденна або святкова укладка залежно від довжини волосся.',
      ],
      [
        'one-tone',
        'Фарбування в один тон',
        'Колористика',
        1800,
        2600,
        7200,
        ['maria'],
        'Фарбування, догляд і завершальна укладка.',
      ],
      [
        'balayage',
        'Balayage / складне фарбування',
        'Колористика',
        3200,
        4800,
        10800,
        ['maria'],
        'Консультація, освітлення, тонування та відновлювальний догляд.',
      ],
      [
        'toning',
        'Тонування волосся',
        'Колористика',
        1400,
        1900,
        5400,
        ['maria'],
        'Оновлення відтінку й блиску волосся.',
      ],
      [
        'manicure',
        'Класичний манікюр',
        'Нігтьовий сервіс',
        500,
        500,
        2700,
        ['olena'],
        'Догляд за нігтями та кутикулою без покриття.',
      ],
      [
        'gel',
        'Манікюр з гель-лаком',
        'Нігтьовий сервіс',
        850,
        850,
        3600,
        ['olena'],
        'Комбінований манікюр і стійке покриття.',
      ],
      [
        'pedicure',
        'Педикюр',
        'Нігтьовий сервіс',
        950,
        950,
        4200,
        ['olena'],
        'Повний догляд за стопами й нігтями.',
      ],
      [
        'cleaning',
        'Чистка обличчя',
        'Догляд за обличчям',
        1200,
        1200,
        4500,
        ['olena'],
        'Діагностика, очищення, маска та зволоження.',
      ],
      [
        'hydration',
        'Зволожувальний догляд',
        'Догляд за обличчям',
        1400,
        1400,
        3600,
        ['olena'],
        'М’який догляд для відновлення захисного бар’єра шкіри.',
      ],
      [
        'peeling',
        'Сезонний пілінг',
        'Догляд за обличчям',
        1100,
        1100,
        2700,
        ['olena'],
        'Делікатне оновлення шкіри з домашніми рекомендаціями.',
      ],
      [
        'brows',
        'Корекція та фарбування брів',
        'Догляд за обличчям',
        450,
        450,
        1800,
        ['olena'],
        'Форма, корекція та природне фарбування брів.',
      ],
    ],
    clientLocale: {
      first: [
        'Оксана',
        'Ірина',
        'Наталія',
        'Христина',
        'Юлія',
        'Катерина',
        'Анастасія',
        'Соломія',
      ],
      last: [
        'Коваль',
        'Мельник',
        'Шевчук',
        'Бондар',
        'Кравчук',
        'Ткаченко',
        'Мороз',
        'Левицька',
      ],
      phonePrefix: '38067700',
      emailDomain: 'example.ua',
    },
  },
];

function log(event, details = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...details })}\n`);
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function getItems(result) {
  return (
    result.structuredContent?.items || result.structuredContent?.rows || []
  );
}

async function getAllAppointments(session, locationId, startDate, endDate) {
  const items = [];
  const ids = new Set();
  for (let page = 1; page <= 20; page += 1) {
    const result = await session.callTool('get_appointments', {
      location_id: locationId,
      start_date: startDate,
      end_date: endDate,
      page,
      count: 300,
    });
    const batch = getItems(result);
    let added = 0;
    for (const item of batch) {
      if (ids.has(item.id)) continue;
      ids.add(item.id);
      items.push(item);
      added += 1;
    }
    if (batch.length < 300 || added === 0) break;
  }
  return items;
}

function apiBase() {
  return (
    process.env.ALTEGIO_API_BASE || 'https://api.alteg.io/api/v1'
  ).replace(/\/$/, '');
}

async function documentedApiRequest(
  path,
  { method = 'GET', query, body, requiresUser = false } = {}
) {
  const partnerToken = process.env.ALTEGIO_API_TOKEN;
  const userToken = process.env.ALTEGIO_USER_TOKEN;
  if (!partnerToken || (requiresUser && !userToken)) {
    throw new Error(
      `Documented API request requires ALTEGIO_API_TOKEN${requiresUser ? ' and ALTEGIO_USER_TOKEN' : ''}`
    );
  }
  const url = new URL(`${apiBase()}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(key, String(item));
    }
  }
  const authorization = requiresUser
    ? `Bearer ${partnerToken}, User ${userToken}`
    : `Bearer ${partnerToken}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: authorization,
      Accept: 'application/vnd.api.v2+json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const responseText = await response.text();
  const payload = responseText ? JSON.parse(responseText) : {};
  if (!response.ok || payload.success === false) {
    throw new Error(
      `Documented API ${method} ${path} failed (HTTP ${response.status}): ${JSON.stringify(payload.errors || payload.meta || payload).slice(0, 500)}`
    );
  }
  return { status: response.status, payload };
}

async function directGetBookingTimes(
  locationId,
  teamMemberId,
  date,
  serviceId
) {
  const { payload } = await documentedApiRequest(
    `/book_times/${locationId}/${teamMemberId}/${date}`,
    { query: { 'service_ids[]': serviceId } }
  );
  return Array.isArray(payload.data) ? payload.data : [];
}

async function directValidateBooking(locationId, appointment, datetime) {
  const { status } = await documentedApiRequest(`/book_check/${locationId}`, {
    method: 'POST',
    body: {
      appointments: [
        {
          id: 1,
          services: [appointment.service_id],
          staff_id: appointment.team_member_id,
          datetime,
        },
      ],
    },
  });
  if (status !== 201) {
    throw new Error(`Booking pre-check returned HTTP ${status}, expected 201`);
  }
}

async function directPayVisit(locationId, appointment) {
  const partnerToken = process.env.ALTEGIO_API_TOKEN;
  const userToken = process.env.ALTEGIO_USER_TOKEN;
  const apiBase = (
    process.env.ALTEGIO_API_BASE || 'https://api.alteg.io/api/v1'
  ).replace(/\/$/, '');
  if (!partnerToken || !userToken) {
    throw new Error(
      'Documented visit payment fallback requires ALTEGIO_API_TOKEN and ALTEGIO_USER_TOKEN'
    );
  }
  const services = (appointment.services || []).map((service) => {
    const cost = Number(service.cost || 0);
    return {
      id: service.id,
      title: service.title,
      cost,
      cost_per_unit: cost,
      discount: 0,
      first_cost: cost,
      record_id: appointment.id,
    };
  });
  if (
    !appointment.visit_id ||
    services.length === 0 ||
    services.some((service) => service.cost <= 0)
  ) {
    throw new Error(
      `Appointment ${appointment.id} is missing a payable visit or service cost`
    );
  }
  const response = await fetch(
    `${apiBase}/visits/${appointment.visit_id}/${appointment.id}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${partnerToken}, User ${userToken}`,
        Accept: 'application/vnd.api.v2+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        attendance: 1,
        comment: appointment.comment || '',
        // Cashless is the only fast-payment mode that is reliably configured on
        // every demo location; some legacy locations accept cash with HTTP 200
        // but create no transaction when no default cash account is selected.
        fast_payment: 2,
        services,
        goods_transactions: [],
        deleted_transaction_ids: [],
      }),
    }
  );
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    throw new Error(
      `Documented visit payment fallback failed (HTTP ${response.status}): ${JSON.stringify(payload.errors || payload.meta || payload).slice(0, 500)}`
    );
  }
}

async function directCreateStaff(locationId, staff) {
  const partnerToken = process.env.ALTEGIO_API_TOKEN;
  const userToken = process.env.ALTEGIO_USER_TOKEN;
  const apiBase = (
    process.env.ALTEGIO_API_BASE || 'https://api.alteg.io/api/v1'
  ).replace(/\/$/, '');
  if (!partnerToken || !userToken) {
    throw new Error(
      'Documented staff fallback requires ALTEGIO_API_TOKEN and ALTEGIO_USER_TOKEN'
    );
  }
  const response = await fetch(`${apiBase}/company/${locationId}/staff/quick`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${partnerToken}, User ${userToken}`,
      Accept: 'application/vnd.api.v2+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: staff.name,
      specialization: staff.specialization,
      position_id: staff.position_id,
      phone_number: null,
      user_email: null,
      user_phone: null,
      is_user_invite: false,
      is_paid_staff: false,
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    throw new Error(
      `Documented staff fallback failed (HTTP ${response.status}): ${JSON.stringify(payload.errors || payload.meta || payload).slice(0, 500)}`
    );
  }
  return payload.data;
}

async function directUpdateStaff(locationId, teamMemberId, data) {
  const partnerToken = process.env.ALTEGIO_API_TOKEN;
  const userToken = process.env.ALTEGIO_USER_TOKEN;
  const apiBase = (
    process.env.ALTEGIO_API_BASE || 'https://api.alteg.io/api/v1'
  ).replace(/\/$/, '');
  if (!partnerToken || !userToken) {
    throw new Error(
      'Documented staff fallback requires ALTEGIO_API_TOKEN and ALTEGIO_USER_TOKEN'
    );
  }
  const response = await fetch(
    `${apiBase}/staff/${locationId}/${teamMemberId}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${partnerToken}, User ${userToken}`,
        Accept: 'application/vnd.api.v2+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    }
  );
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    throw new Error(
      `Documented staff update fallback failed (HTTP ${response.status}): ${JSON.stringify(payload.errors || payload.meta || payload).slice(0, 500)}`
    );
  }
  return payload.data;
}

function clientsFor(profile) {
  const clients = [];
  let index = 0;
  for (const first of profile.clientLocale.first) {
    for (const last of profile.clientLocale.last) {
      index += 1;
      clients.push({
        name: `${first} ${last}`,
        phone: `${profile.clientLocale.phonePrefix}${String(index).padStart(4, '0')}`,
        email: `client${index}.${profile.id}@${profile.clientLocale.emailDomain}`,
      });
    }
  }
  return clients;
}

function scheduleDates(
  staff,
  startOffset = -SCHEDULE_PAST_DAYS,
  endOffset = SCHEDULE_FUTURE_DAYS
) {
  const dates = [];
  for (let offset = startOffset; offset <= endOffset; offset += 1) {
    const date = addDays(ANCHOR, offset);
    if (!staff.daysOff.includes(date.getUTCDay())) dates.push(isoDate(date));
  }
  return dates;
}

function parseMinutes(value) {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function formatMinutes(value) {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function localDateTimeKey(timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function scheduleContains(scheduleDay, datetime, durationSeconds) {
  if (!scheduleDay?.is_working) return false;
  const start = parseMinutes(datetime.slice(11, 16));
  const end = start + Math.ceil(Number(durationSeconds || 3600) / 60);
  return (scheduleDay.slots || []).some(
    (slot) => start >= parseMinutes(slot.from) && end <= parseMinutes(slot.to)
  );
}

async function readScheduleIndex(session, profile, staffByKey) {
  const index = new Map();
  for (const staff of profile.staff.filter(
    (teamMember) => teamMember.provider !== false
  )) {
    const teamMemberId = staffByKey.get(staff.key).id;
    const result = await session.callTool('get_schedule', {
      location_id: profile.id,
      team_member_id: teamMemberId,
      start_date: isoDate(addDays(ANCHOR, -SCHEDULE_PAST_DAYS)),
      end_date: isoDate(addDays(ANCHOR, SCHEDULE_FUTURE_DAYS)),
    });
    for (const day of getItems(result)) {
      const date = (day.date || day.datetime || '').slice(0, 10);
      index.set(`${teamMemberId}|${date}`, {
        is_working: Boolean(day.is_working),
        slots: day.slots || [],
      });
    }
  }
  return index;
}

function dailyDemand(staff, maxTarget, direction) {
  const relative = staff.target / maxTarget;
  if (direction === 'past') {
    if (relative >= 0.9) return 4;
    if (relative >= 0.55) return 3;
    return 2;
  }
  if (relative >= 0.9) return 3;
  if (relative >= 0.55) return 2;
  return 1;
}

function chooseService(priced, desiredBand, maxDurationSeconds, seed) {
  const value = priced[0];
  const premium = priced.at(-1);
  const core = priced.slice(1, -1);
  const preferred =
    desiredBand === 'value'
      ? [value]
      : desiredBand === 'premium'
        ? [premium]
        : core.length
          ? core
          : priced;
  const rotated = preferred.length
    ? preferred.map((_, index) => preferred[(index + seed) % preferred.length])
    : [];
  const candidates = [...rotated, ...priced].filter(
    (service, index, all) => all.indexOf(service) === index
  );
  return candidates.find((service) => service[5] <= maxDurationSeconds);
}

function buildAppointmentPlan(profile, staffByKey, servicesByKey) {
  const clients = clientsFor(profile);
  const plan = [];
  const providers = profile.staff.filter((staff) => staff.provider !== false);
  const maxTarget = Math.max(...providers.map((staff) => staff.target));
  let appointmentIndex = 0;

  for (const direction of ['past', 'future']) {
    const offsets =
      direction === 'past'
        ? Array.from(
            { length: HISTORY_DAYS },
            (_, index) => -HISTORY_DAYS + index
          )
        : Array.from({ length: FUTURE_DAYS + 1 }, (_, index) => index);
    for (const [dayIndex, offset] of offsets.entries()) {
      const date = addDays(ANCHOR, offset);
      for (const [staffIndex, staff] of providers.entries()) {
        if (staff.daysOff.includes(date.getUTCDay())) continue;
        const staffServices = profile.services.filter((service) =>
          service[6].includes(staff.key)
        );
        const priced = [...staffServices].sort((a, b) => a[3] - b[3]);
        const target = dailyDemand(staff, maxTarget, direction);
        const slotCounts = staff.slots.map((_, index) =>
          index === staff.slots.length - 1
            ? Math.ceil(target / staff.slots.length)
            : Math.floor(target / staff.slots.length)
        );

        for (const [slotIndex, slot] of staff.slots.entries()) {
          let cursor = parseMinutes(slot[0]);
          const end = parseMinutes(slot[1]);
          const count = slotCounts[slotIndex];
          for (let inSlot = 0; inSlot < count; inSlot += 1) {
            const remaining = count - inSlot - 1;
            const maxDurationSeconds =
              Math.max(0, end - cursor - remaining * 30) * 60;
            const desiredBand = ['value', 'premium', 'core', 'core'][
              appointmentIndex % 4
            ];
            const service = chooseService(
              priced,
              desiredBand,
              maxDurationSeconds,
              appointmentIndex + staffIndex + dayIndex
            );
            if (!service) break;
            const time = formatMinutes(cursor);
            const peak =
              [4, 5, 6].includes(date.getUTCDay()) || cursor >= 16 * 60;
            const priceBand =
              service === priced[0]
                ? 'value'
                : service === priced.at(-1)
                  ? 'premium'
                  : 'core';
            const attendance =
              direction === 'past'
                ? [1, 1, 1, 1, 1, 1, 1, 1, -1, 1, 1, 2, 1, 1, 0][
                    (appointmentIndex + staffIndex) % 15
                  ]
                : [2, 2, 0, 2, 0, 2, 2, 0][(appointmentIndex + staffIndex) % 8];
            const client =
              clients[
                (appointmentIndex * 5 + staffIndex * 3 + dayIndex * 7) %
                  clients.length
              ];
            plan.push({
              staffKey: staff.key,
              team_member_id: staffByKey.get(staff.key).id,
              serviceKey: service[0],
              service_id: servicesByKey.get(service[0]).id,
              datetime: `${isoDate(date)}T${time}:00`,
              session_length: service[5],
              client,
              attendance,
              direction,
              peak,
              priceBand,
            });
            cursor += Math.ceil(service[5] / 60);
            appointmentIndex += 1;
          }
        }
      }
    }
  }
  return plan;
}

async function ensureLocation(session, profile) {
  if (!APPLY) return;
  await session.callTool('update_location', {
    location_id: profile.id,
    title: profile.title,
    ...profile.location,
  });
  await session.callTool('update_online_booking_settings', {
    location_id: profile.id,
    any_team_member: true,
    confirm_number: false,
    session_delay_step: 30,
    online_group_event_max_seats: 6,
  });
}

async function ensureCategories(session, profile) {
  let result = await session.callTool('get_service_categories', {
    location_id: profile.id,
    page: 1,
    count: 100,
  });
  let categories = getItems(result);
  const missing = profile.categories.filter(
    (title) => !categories.some((category) => category.title === title)
  );
  if (APPLY && missing.length) {
    const args = {
      location_id: profile.id,
      categories: missing.map((title, index) => ({
        title,
        weight: 100 - index * 10,
      })),
    };
    try {
      await session.callTool('onboarding_add_categories', args);
    } catch (error) {
      if (!error.message.includes('No onboarding session')) throw error;
      await session.callTool('onboarding_start', { location_id: profile.id });
      await session.callTool('onboarding_add_categories', args);
    }
    result = await session.callTool('get_service_categories', {
      location_id: profile.id,
      page: 1,
      count: 100,
    });
    categories = getItems(result);
  }
  const map = new Map(
    profile.categories.map((title) => [
      title,
      categories.find((category) => category.title === title),
    ])
  );
  for (const [title, category] of map)
    if (!category) throw new Error(`${profile.id}: missing category ${title}`);
  log('categories', {
    location_id: profile.id,
    curated: map.size,
    created: missing.length,
  });
  return map;
}

async function ensureStaff(session, profile) {
  let result = await session.callTool('get_staff', {
    location_id: profile.id,
    page: 1,
    count: 100,
  });
  let staffItems = getItems(result);
  if (APPLY) {
    for (const name of [
      ...(profile.legacyStaffToDelete || []),
      ...(profile.demoStaffToRemove || []),
    ]) {
      const current = staffItems.find((item) => item.name === name);
      if (current) {
        await session.callTool('delete_staff', {
          location_id: profile.id,
          team_member_id: current.id,
        });
      }
    }
    result = await session.callTool('get_staff', {
      location_id: profile.id,
      page: 1,
      count: 100,
    });
    staffItems = getItems(result);
  }
  let positions;
  const resolvePosition = async (title) => {
    positions ||= getItems(
      await session.callTool('get_positions', { location_id: profile.id })
    );
    let position = positions.find((item) => item.title === title);
    if (!position && APPLY) {
      const created = await session.callTool('create_position', {
        location_id: profile.id,
        title,
      });
      position = created.structuredContent;
      positions.push(position);
    }
    if (!position) throw new Error(`${profile.id}: missing position ${title}`);
    return position.id;
  };
  const missing = profile.staff.filter(
    (staff) => !staffItems.some((item) => item.name === staff.name)
  );
  const createdNames = new Set(missing.map((staff) => staff.name));
  if (APPLY && missing.length) {
    for (const staff of missing) {
      await directCreateStaff(profile.id, {
        name: staff.name,
        specialization: staff.specialization,
        position_id: await resolvePosition(
          staff.provider === false
            ? profile.receptionPosition
            : profile.providerPosition
        ),
      });
    }
    result = await session.callTool('get_staff', {
      location_id: profile.id,
      page: 1,
      count: 100,
    });
    staffItems = getItems(result);
  }
  for (const staff of profile.staff) {
    const current = staffItems.find((item) => item.name === staff.name);
    if (!current) throw new Error(`${profile.id}: missing staff ${staff.name}`);
    if (APPLY) {
      const update = {
        name: staff.name,
        specialization: staff.specialization,
        weight: staff.weight,
        information: `<p>${staff.specialization}. ${staff.provider === false ? profile.receptionBio : profile.providerBio}</p>`,
        hidden: 0,
        fired: 0,
        has_access_timetable: staff.provider !== false,
      };
      if (createdNames.has(staff.name))
        update.is_paid_staff = staff.provider !== false;
      await directUpdateStaff(profile.id, current.id, update);
    }
  }
  result = await session.callTool('get_staff', {
    location_id: profile.id,
    page: 1,
    count: 100,
  });
  staffItems = getItems(result);
  const map = new Map(
    profile.staff.map((staff) => [
      staff.key,
      staffItems.find((item) => item.name === staff.name),
    ])
  );
  log('staff', {
    location_id: profile.id,
    curated: map.size,
    providers: profile.staff.filter((staff) => staff.provider !== false).length,
    created: missing.length,
  });
  return map;
}

async function ensureServices(session, profile, categories, staffByKey) {
  let result = await session.callTool('get_services', {
    location_id: profile.id,
    page: 1,
    count: 100,
  });
  let items = getItems(result);

  if (APPLY) {
    for (const title of profile.demoServicesToRemove || []) {
      const current = items.find((item) => item.title === title);
      if (current)
        await session.callTool('delete_service', {
          location_id: profile.id,
          service_id: current.id,
        });
    }
    result = await session.callTool('get_services', {
      location_id: profile.id,
      page: 1,
      count: 100,
    });
    items = getItems(result);
  }

  for (const service of profile.services) {
    const [key, title, categoryTitle, priceMin, priceMax, duration, , comment] =
      service;
    let current = items.find((item) => item.title === title);
    const category = categories.get(categoryTitle);
    if (!current && APPLY) {
      await session.callTool('create_service', {
        location_id: profile.id,
        title,
        category_id: category.id,
        price_min: priceMin,
        price_max: priceMax,
        duration,
        comment,
        active: 1,
      });
      result = await session.callTool('get_services', {
        location_id: profile.id,
        page: 1,
        count: 100,
      });
      items = getItems(result);
      current = items.find((item) => item.title === title);
    }
    if (!current) throw new Error(`${profile.id}: missing service ${title}`);
    if (APPLY) {
      await session.callTool('update_service', {
        location_id: profile.id,
        service_id: current.id,
        title,
        category_id: category.id,
        price_min: priceMin,
        price_max: priceMax,
        duration,
        comment,
        discount: 0,
        active: 1,
      });
    }
    current.demoKey = key;
  }

  result = await session.callTool('get_services', {
    location_id: profile.id,
    page: 1,
    count: 100,
  });
  items = getItems(result);
  const map = new Map(
    profile.services.map((service) => [
      service[0],
      items.find((item) => item.title === service[1]),
    ])
  );

  if (APPLY) {
    for (const service of profile.services) {
      const current = map.get(service[0]);
      const links = new Map(
        (current.team_members || []).map((link) => [link.team_member_id, link])
      );
      for (const staffKey of service[6]) {
        const teamMemberId = staffByKey.get(staffKey).id;
        const existingLink = links.get(teamMemberId);
        if (!existingLink) {
          await session.callTool('link_service_team_member', {
            location_id: profile.id,
            service_id: current.id,
            team_member_id: teamMemberId,
            session_length: service[5],
          });
        } else if (existingLink.session_length_seconds !== service[5]) {
          await session.callTool('update_service_team_member', {
            location_id: profile.id,
            service_id: current.id,
            team_member_id: teamMemberId,
            session_length: service[5],
          });
        }
      }
    }
  }
  log('services', { location_id: profile.id, curated: map.size });
  return map;
}

async function ensureSchedules(session, profile, staffByKey) {
  const providers = profile.staff.filter((staff) => staff.provider !== false);
  if (APPLY) {
    for (const staff of providers) {
      const dates = scheduleDates(staff);
      for (let index = 0; index < dates.length; index += 75) {
        await session.callTool('create_schedule', {
          location_id: profile.id,
          team_member_id: staffByKey.get(staff.key).id,
          dates: dates.slice(index, index + 75),
          slots: staff.slots.map(([from, to]) => ({ from, to })),
        });
      }
    }
  }
  log('schedules', {
    location_id: profile.id,
    providers: providers.length,
    past_days: SCHEDULE_PAST_DAYS,
    future_days: SCHEDULE_FUTURE_DAYS,
  });
}

function mergedSlots(slots, requiredIntervals) {
  const intervals = [
    ...(slots || []).map((slot) => [
      parseMinutes(slot.from),
      parseMinutes(slot.to),
    ]),
    ...requiredIntervals,
  ].sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval[0] <= previous[1]) {
      previous[1] = Math.max(previous[1], interval[1]);
    } else {
      merged.push([...interval]);
    }
  }
  return merged.map(([from, to]) => ({
    from: formatMinutes(from),
    to: formatMinutes(to),
  }));
}

async function repairAppointmentScheduleVisibility(
  session,
  profile,
  staffByKey,
  servicesByKey
) {
  const start = isoDate(addDays(ANCHOR, -HISTORY_DAYS - 1));
  const end = isoDate(addDays(ANCHOR, FUTURE_DAYS + 1));
  const appointments = await getAllAppointments(
    session,
    profile.id,
    start,
    end
  );
  const providers = profile.staff.filter((staff) => staff.provider !== false);
  const providerById = new Map(
    providers.map((staff) => [staffByKey.get(staff.key).id, staff])
  );
  const durationByServiceId = new Map(
    profile.services.map((definition) => [
      servicesByKey.get(definition[0]).id,
      definition[5],
    ])
  );
  const curatedServiceIds = new Set(durationByServiceId.keys());
  const scheduleIndex = await readScheduleIndex(session, profile, staffByKey);
  const requiredByStaffDay = new Map();
  for (const appointment of appointments) {
    if (!providerById.has(appointment.team_member_id)) continue;
    if (
      !appointment.services?.some((service) =>
        curatedServiceIds.has(service.id)
      )
    )
      continue;
    const datetime = (appointment.datetime || appointment.date).replace(
      ' ',
      'T'
    );
    const duration =
      appointment.services.reduce(
        (total, service) => total + (durationByServiceId.get(service.id) || 0),
        0
      ) || 3600;
    const key = `${appointment.team_member_id}|${datetime.slice(0, 10)}`;
    const scheduleDay = scheduleIndex.get(key);
    if (scheduleContains(scheduleDay, datetime, duration)) continue;
    const intervals = requiredByStaffDay.get(key) || [];
    const appointmentStart = parseMinutes(datetime.slice(11, 16));
    intervals.push([
      appointmentStart,
      appointmentStart + Math.ceil(duration / 60),
    ]);
    requiredByStaffDay.set(key, intervals);
  }

  let repaired = 0;
  if (APPLY) {
    for (const [key, requiredIntervals] of requiredByStaffDay) {
      const [teamMemberIdRaw, date] = key.split('|');
      const teamMemberId = Number(teamMemberIdRaw);
      const staff = providerById.get(teamMemberId);
      const current = scheduleIndex.get(key);
      const slots = mergedSlots(
        current?.is_working
          ? current.slots
          : staff.slots.map(([from, to]) => ({ from, to })),
        requiredIntervals
      );
      await session.callTool('create_schedule', {
        location_id: profile.id,
        team_member_id: teamMemberId,
        dates: [date],
        slots,
      });
      const readback = getItems(
        await session.callTool('get_schedule', {
          location_id: profile.id,
          team_member_id: teamMemberId,
          start_date: date,
          end_date: date,
        })
      )[0];
      if (
        !requiredIntervals.every(([from, to]) =>
          scheduleContains(
            readback,
            `${date}T${formatMinutes(from)}:00`,
            (to - from) * 60
          )
        )
      ) {
        throw new Error(
          `${profile.id}: schedule repair did not persist for ${key}`
        );
      }
      repaired += 1;
    }
  }
  log('schedule_visibility_repairs', {
    location_id: profile.id,
    affected_employee_days: requiredByStaffDay.size,
    repaired,
  });
  return { affected_employee_days: requiredByStaffDay.size, repaired };
}

async function ensureBookingForm(session, profile) {
  const forms = getItems(
    await session.callTool('get_booking_forms', { location_id: profile.id })
  );
  const exists = forms.some((form) => form.title === profile.bookingForm.title);
  if (APPLY && !exists) {
    await session.callTool('create_booking_form', {
      location_id: profile.id,
      ...profile.bookingForm,
      is_default: true,
      without_menu: false,
    });
  }
  log('booking_form', {
    location_id: profile.id,
    present: exists || APPLY,
    created: APPLY && !exists,
  });
}

async function ensureAppointments(session, profile, staffByKey, servicesByKey) {
  const plan = buildAppointmentPlan(profile, staffByKey, servicesByKey);
  const windowStart = isoDate(addDays(ANCHOR, -HISTORY_DAYS - 1));
  const windowEnd = isoDate(addDays(ANCHOR, FUTURE_DAYS + 1));
  const scheduleIndex = await readScheduleIndex(session, profile, staffByKey);
  const existing = await getAllAppointments(
    session,
    profile.id,
    windowStart,
    windowEnd
  );
  const durationByServiceId = new Map(
    profile.services.map((definition) => [
      servicesByKey.get(definition[0]).id,
      definition[5],
    ])
  );
  const appointmentDuration = (item) =>
    Number(item.duration_seconds) ||
    (item.services || []).reduce(
      (total, service) => total + (durationByServiceId.get(service.id) || 0),
      0
    ) ||
    3600;
  const occupied = new Map();
  const addOccupied = (teamMemberId, datetime, durationSeconds) => {
    const normalized = datetime.replace(' ', 'T');
    const dayKey = `${teamMemberId}|${normalized.slice(0, 10)}`;
    const start = parseMinutes(normalized.slice(11, 16));
    const end = start + Math.ceil(Number(durationSeconds || 3600) / 60);
    const intervals = occupied.get(dayKey) || [];
    intervals.push([start, end]);
    occupied.set(dayKey, intervals);
  };
  const isOccupied = (appointment) => {
    const dayKey = `${appointment.team_member_id}|${appointment.datetime.slice(0, 10)}`;
    const start = parseMinutes(appointment.datetime.slice(11, 16));
    const end = start + Math.ceil(appointment.session_length / 60);
    return (occupied.get(dayKey) || []).some(
      ([busyStart, busyEnd]) => start < busyEnd && end > busyStart
    );
  };
  for (const item of existing) {
    addOccupied(
      item.team_member_id,
      item.datetime || item.date,
      appointmentDuration(item)
    );
  }
  let created = 0;
  let skipped = 0;
  const failures = [];
  const validation = {
    schedule_checks: 0,
    live_occupancy_checks: 0,
    online_session_checks: 0,
    booking_prechecks: 0,
    online_unavailable_fallbacks: 0,
    historical_admin_checks: 0,
    readback_checks: 0,
  };

  if (APPLY) {
    for (let index = 0; index < plan.length; index += 1) {
      const appointment = plan[index];
      if (isOccupied(appointment)) {
        skipped += 1;
        continue;
      }
      try {
        const date = appointment.datetime.slice(0, 10);
        const scheduleDay = scheduleIndex.get(
          `${appointment.team_member_id}|${date}`
        );
        validation.schedule_checks += 1;
        if (
          !scheduleContains(
            scheduleDay,
            appointment.datetime,
            appointment.session_length
          )
        ) {
          throw new Error(
            `Appointment is outside a working schedule: ${appointment.datetime}`
          );
        }

        // Re-read the day immediately before every write. The initial window read
        // is only a planning cache and must not be treated as an availability lock.
        const liveDay = await getAllAppointments(
          session,
          profile.id,
          date,
          date
        );
        validation.live_occupancy_checks += 1;
        const candidateStart = parseMinutes(appointment.datetime.slice(11, 16));
        const candidateEnd =
          candidateStart + Math.ceil(appointment.session_length / 60);
        const liveConflict = liveDay.some((item) => {
          if (item.team_member_id !== appointment.team_member_id) return false;
          const itemDateTime = (item.datetime || item.date).replace(' ', 'T');
          const itemStart = parseMinutes(itemDateTime.slice(11, 16));
          const itemEnd = itemStart + Math.ceil(appointmentDuration(item) / 60);
          return candidateStart < itemEnd && candidateEnd > itemStart;
        });
        if (liveConflict) {
          throw new Error(
            `Live appointment read found a conflict: ${appointment.datetime}`
          );
        }

        const isOnlineFuture =
          appointment.datetime.slice(0, 16) >
          localDateTimeKey(profile.timeZone);
        if (isOnlineFuture) {
          const sessions = await directGetBookingTimes(
            profile.id,
            appointment.team_member_id,
            date,
            appointment.service_id
          );
          validation.online_session_checks += 1;
          if (sessions.length === 0) {
            // Some demo locations expose a working B2B calendar but no public
            // online-booking sessions. Keep that limitation explicit and rely
            // on the just-in-time B2B checks plus the create endpoint's default
            // save_if_busy=false enforcement.
            validation.online_unavailable_fallbacks += 1;
          } else {
            const available = sessions.find(
              (slot) => slot.time === appointment.datetime.slice(11, 16)
            );
            if (!available) {
              throw new Error(
                `Backend did not return ${appointment.datetime.slice(11, 16)} as a bookable session`
              );
            }
            await directValidateBooking(
              profile.id,
              appointment,
              available.datetime || appointment.datetime
            );
            validation.booking_prechecks += 1;
          }
        } else {
          // Public online-booking availability intentionally excludes elapsed
          // time. Historical demo rows therefore use the authoritative B2B
          // schedule plus a live occupancy read, never a synthetic slot model.
          validation.historical_admin_checks += 1;
        }

        const createdResult = await session.callTool('create_appointment', {
          location_id: profile.id,
          team_member_id: appointment.team_member_id,
          services: [{ id: appointment.service_id, amount: 1 }],
          datetime: appointment.datetime,
          session_length: appointment.session_length,
          client: appointment.client,
          comment: `Demo ${isoDate(ANCHOR).slice(0, 7)} · ${appointment.peak ? 'peak' : 'off-peak'} · ${appointment.priceBand}`,
          send_sms: 0,
          attendance: appointment.attendance,
        });
        const createdId = createdResult.structuredContent?.id;
        const readback = await getAllAppointments(
          session,
          profile.id,
          date,
          date
        );
        validation.readback_checks += 1;
        if (!createdId || !readback.some((item) => item.id === createdId)) {
          throw new Error(
            `Appointment ${createdId || '(missing id)'} was not visible in day read-back`
          );
        }
        addOccupied(
          appointment.team_member_id,
          appointment.datetime,
          appointment.session_length
        );
        created += 1;
      } catch (error) {
        failures.push({
          datetime: appointment.datetime,
          staff: appointment.staffKey,
          error: error.message.slice(0, 240),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
      if ((index + 1) % 25 === 0)
        log('appointment_progress', {
          location_id: profile.id,
          processed: index + 1,
          total: plan.length,
          created,
          skipped,
          failed: failures.length,
        });
    }
  }
  log('appointments', {
    location_id: profile.id,
    target: plan.length,
    created,
    skipped,
    failed: failures.length,
    validation,
  });
  if (failures.length)
    log('appointment_failures', {
      location_id: profile.id,
      failures: failures.slice(0, 10),
    });
  return { plan, failures, validation };
}

async function ensurePaidSales(session, profile, staffByKey, servicesByKey) {
  const start = isoDate(addDays(ANCHOR, -HISTORY_DAYS - 1));
  const end = isoDate(addDays(ANCHOR, -1));
  const nowKey = isoDate(ANCHOR);
  const appointments = await getAllAppointments(
    session,
    profile.id,
    start,
    end
  );
  const providerIds = new Set(
    profile.staff
      .filter((staff) => staff.provider !== false)
      .map((staff) => staffByKey.get(staff.key).id)
  );
  const serviceIds = new Set(
    [...servicesByKey.values()].map((service) => service.id)
  );
  const payable = appointments.filter(
    (appointment) =>
      providerIds.has(appointment.team_member_id) &&
      (appointment.datetime || appointment.date).slice(0, 10) < nowKey &&
      appointment.status === 'arrived' &&
      !appointment.paid_in_full &&
      appointment.comment?.startsWith('Demo ') &&
      appointment.services?.length > 0 &&
      appointment.services.every((service) => serviceIds.has(service.id))
  );
  let paid = 0;
  const failures = [];
  if (APPLY) {
    for (let index = 0; index < payable.length; index += 1) {
      const appointment = payable[index];
      try {
        await directPayVisit(profile.id, appointment);
        paid += 1;
      } catch (error) {
        failures.push({
          appointment_id: appointment.id,
          error: error.message.slice(0, 240),
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
      if ((index + 1) % 25 === 0) {
        log('sales_progress', {
          location_id: profile.id,
          processed: index + 1,
          total: payable.length,
          paid,
          failed: failures.length,
        });
      }
    }
  }
  log('sales', {
    location_id: profile.id,
    payable: payable.length,
    paid,
    failed: failures.length,
  });
  if (failures.length)
    log('sales_failures', {
      location_id: profile.id,
      failures: failures.slice(0, 10),
    });
  return failures;
}

async function audit(
  session,
  profile,
  staffByKey,
  servicesByKey,
  plan,
  writeValidation
) {
  const start = isoDate(addDays(ANCHOR, -HISTORY_DAYS - 1));
  const end = isoDate(addDays(ANCHOR, FUTURE_DAYS + 1));
  const nowKey = isoDate(ANCHOR);
  const appointments = await getAllAppointments(
    session,
    profile.id,
    start,
    end
  );
  const providers = profile.staff.filter((staff) => staff.provider !== false);
  const providerIds = new Set(
    providers.map((staff) => staffByKey.get(staff.key).id)
  );
  const curatedServiceIds = new Set(
    [...servicesByKey.values()].map((service) => service.id)
  );
  const curated = appointments.filter(
    (item) =>
      providerIds.has(item.team_member_id) &&
      item.services?.some((service) => curatedServiceIds.has(service.id))
  );
  const statusCounts = {};
  const staffCounts = {};
  for (const item of curated) {
    statusCounts[item.status] = (statusCounts[item.status] || 0) + 1;
    staffCounts[item.team_member_name] =
      (staffCounts[item.team_member_name] || 0) + 1;
  }
  const past = curated.filter(
    (item) => (item.datetime || item.date).slice(0, 10) < nowKey
  ).length;
  const today = curated.filter(
    (item) => (item.datetime || item.date).slice(0, 10) === nowKey
  ).length;
  const future = curated.filter(
    (item) => (item.datetime || item.date).slice(0, 10) > nowKey
  ).length;
  const paidSales = curated.filter(
    (item) =>
      (item.datetime || item.date).slice(0, 10) < nowKey &&
      item.status === 'arrived' &&
      item.paid_in_full
  ).length;
  const operationalByDay = new Map();
  for (const item of appointments.filter((entry) =>
    providerIds.has(entry.team_member_id)
  )) {
    const date = (item.datetime || item.date).slice(0, 10);
    const coverage = operationalByDay.get(date) || {
      appointments: 0,
      staff: new Set(),
    };
    coverage.appointments += 1;
    coverage.staff.add(item.team_member_id);
    operationalByDay.set(date, coverage);
  }
  const clientResult = await session.callTool('clients_search', {
    location_id: profile.id,
    page: 1,
    page_size: 1,
  });
  const serviceResult = await session.callTool('get_services', {
    location_id: profile.id,
    page: 1,
    count: 100,
  });
  const services = getItems(serviceResult);
  const linkFailures = [];
  for (const definition of profile.services) {
    const service = services.find((item) => item.title === definition[1]);
    const linked = new Set(
      (service?.team_members || []).map((link) => link.team_member_id)
    );
    for (const staffKey of definition[6]) {
      if (!linked.has(staffByKey.get(staffKey).id))
        linkFailures.push(`${definition[1]} -> ${staffKey}`);
    }
  }
  const scheduleChecks = [];
  const scheduledByDay = new Map();
  const scheduleByStaffDay = new Map();
  const providerChecks = [];
  for (const staff of providers) {
    const result = await session.callTool('get_schedule', {
      location_id: profile.id,
      team_member_id: staffByKey.get(staff.key).id,
      start_date: isoDate(addDays(ANCHOR, -SCHEDULE_PAST_DAYS)),
      end_date: isoDate(addDays(ANCHOR, SCHEDULE_FUTURE_DAYS)),
    });
    const days = getItems(result);
    const months = {};
    for (const day of days) {
      const date = (day.date || day.datetime || '').slice(0, 10);
      scheduleByStaffDay.set(`${staffByKey.get(staff.key).id}|${date}`, {
        is_working: Boolean(day.is_working),
        slots: day.slots || [],
      });
      if (!day.is_working) continue;
      const month = date.slice(0, 7);
      months[month] = (months[month] || 0) + 1;
      const scheduled = scheduledByDay.get(date) || new Set();
      scheduled.add(staffByKey.get(staff.key).id);
      scheduledByDay.set(date, scheduled);
    }
    scheduleChecks.push({
      staff: staff.name,
      working_days: days.filter((day) => day.is_working).length,
      months,
    });
    const detail = await session.callTool('altegio_call_operation', {
      operation_id: 'get_team_member',
      params: {
        location_id: profile.id,
        team_member_id: staffByKey.get(staff.key).id,
      },
    });
    const data = detail.structuredContent?.data || {};
    providerChecks.push({
      staff: staff.name,
      is_bookable: data.is_bookable,
      has_schedule: data.has_schedule,
      service_links: data.services_links?.length || 0,
    });
  }
  const durationByServiceId = new Map(
    profile.services.map((definition) => [
      servicesByKey.get(definition[0]).id,
      definition[5],
    ])
  );
  const scheduleViolations = [];
  for (const appointment of curated) {
    const datetime = (appointment.datetime || appointment.date).replace(
      ' ',
      'T'
    );
    const duration =
      (appointment.services || []).reduce(
        (total, service) => total + (durationByServiceId.get(service.id) || 0),
        0
      ) || 3600;
    const day = scheduleByStaffDay.get(
      `${appointment.team_member_id}|${datetime.slice(0, 10)}`
    );
    if (!scheduleContains(day, datetime, duration)) {
      scheduleViolations.push({
        appointment_id: appointment.id,
        team_member_id: appointment.team_member_id,
        datetime,
        duration_seconds: duration,
        reason: day?.is_working
          ? 'outside_working_slots'
          : 'nonworking_or_missing_day',
      });
    }
  }
  const dailyCoverage = [];
  for (let offset = -HISTORY_DAYS; offset <= FUTURE_DAYS; offset += 1) {
    const date = addDays(ANCHOR, offset);
    if (profile.closedWeekdays.includes(date.getUTCDay())) continue;
    const key = isoDate(date);
    const operational = operationalByDay.get(key) || {
      appointments: 0,
      staff: new Set(),
    };
    dailyCoverage.push({
      date: key,
      direction: offset < 0 ? 'past' : 'future',
      scheduled_staff: scheduledByDay.get(key)?.size || 0,
      appointment_staff: operational.staff.size,
      appointments: operational.appointments,
    });
  }
  const sparseDays = dailyCoverage.filter((day) => {
    const requiredAppointments =
      day.direction === 'past'
        ? profile.dailyMinimum.pastAppointments
        : profile.dailyMinimum.futureAppointments;
    return (
      day.scheduled_staff < profile.dailyMinimum.scheduledStaff ||
      day.appointment_staff < profile.dailyMinimum.scheduledStaff ||
      day.appointments < requiredAppointments
    );
  });
  const forms = getItems(
    await session.callTool('get_booking_forms', { location_id: profile.id })
  );
  const appointmentSettings = await session.callTool(
    'get_appointment_settings',
    { location_id: profile.id }
  );
  const onlineSettings = await session.callTool('get_online_booking_settings', {
    location_id: profile.id,
  });
  const resources = getItems(
    await session.callTool('get_resources', { location_id: profile.id })
  );
  const users = await session.callTool('altegio_call_operation', {
    operation_id: 'get_location_users',
    params: { location_id: profile.id },
  });
  const location = await session.callTool('altegio_call_operation', {
    operation_id: 'get_location',
    params: { location_id: profile.id },
  });
  const locationData = location.structuredContent?.data || {};
  const analyticsSession = await new HostedMcpSession({
    token: process.env.ALTEGIO_USER_TOKEN,
    companyId: profile.id,
    endpoint: `${session.endpoint}/analytics`,
  }).initialize();
  let breakdown;
  let overview;
  try {
    breakdown = await analyticsSession.callTool(
      'analytics_get_appointments_breakdown',
      {
        location_id: profile.id,
        group_by: 'visit_status',
        date_from: start,
        date_to: end,
      }
    );
    overview = await analyticsSession.callTool('analytics_get_overview', {
      location_id: profile.id,
      date_from: start,
      date_to: end,
    });
  } finally {
    await analyticsSession.close();
  }
  const analyticsOutcomes = Object.fromEntries(
    (breakdown.structuredContent?.breakdown || []).map((item) => [
      item.key,
      item.count,
    ])
  );
  log('audit', {
    location_id: profile.id,
    title: locationData.title,
    city: locationData.city,
    timezone: locationData.timezone_name,
    currency: locationData.currency_short_title,
    providers: providers.length,
    curated_services: profile.services.length,
    clients: clientResult.structuredContent?.total_count,
    curated_appointments: curated.length,
    past,
    today,
    future,
    projected_statuses: statusCounts,
    analytics_outcomes: analyticsOutcomes,
    analytics_currency: overview.structuredContent?.currency,
    revenue: overview.structuredContent?.revenue?.total?.current,
    services_revenue: overview.structuredContent?.revenue?.services?.current,
    by_staff: staffCounts,
    paid_sales: paidSales,
    daily_coverage: {
      open_days: dailyCoverage.length,
      minimum_scheduled_staff: Math.min(
        ...dailyCoverage.map((day) => day.scheduled_staff)
      ),
      minimum_appointment_staff: Math.min(
        ...dailyCoverage.map((day) => day.appointment_staff)
      ),
      minimum_appointments: Math.min(
        ...dailyCoverage.map((day) => day.appointments)
      ),
      sparse_days: sparseDays.slice(0, 12),
      sparse_days_count: sparseDays.length,
    },
    planned_peak_share: Number(
      (plan.filter((item) => item.peak).length / plan.length).toFixed(2)
    ),
    planned_value_share: Number(
      (
        plan.filter((item) => item.priceBand === 'value').length / plan.length
      ).toFixed(2)
    ),
    planned_premium_share: Number(
      (
        plan.filter((item) => item.priceBand === 'premium').length / plan.length
      ).toFixed(2)
    ),
    schedule_checks: scheduleChecks,
    appointment_schedule_visibility: {
      checked: curated.length,
      violations: scheduleViolations.slice(0, 12),
      violation_count: scheduleViolations.length,
    },
    write_validation: writeValidation,
    provider_checks: providerChecks,
    service_link_failures: linkFailures,
    booking_form: forms.some(
      (form) => form.title === profile.bookingForm.title
    ),
    appointment_settings_readable: Boolean(
      appointmentSettings.structuredContent
    ),
    online_settings_readable: Boolean(onlineSettings.structuredContent),
    residual_resources: resources.length,
    residual_location_users: Array.isArray(users.structuredContent?.data)
      ? users.structuredContent.data.length
      : 0,
  });
  if (
    APPLY &&
    (locationData.title !== profile.title ||
      linkFailures.length ||
      past <
        Math.floor(
          plan.filter((item) => item.direction === 'past').length * 0.9
        ) ||
      future <
        Math.floor(
          plan.filter((item) => item.datetime.slice(0, 10) > nowKey).length *
            0.85
        ) ||
      today <
        Math.floor(
          plan.filter((item) => item.datetime.slice(0, 10) === nowKey).length *
            0.85
        ) ||
      paidSales <
        Math.floor(
          plan.filter(
            (item) => item.direction === 'past' && item.attendance === 1
          ).length * 0.85
        ) ||
      scheduleChecks.some((check) => check.working_days < 40) ||
      scheduleViolations.length > 0 ||
      sparseDays.length > 0 ||
      providers.some(
        (staff) =>
          (staffCounts[staff.name] || 0) < Math.floor(staff.target * 0.8)
      ) ||
      providerChecks.some(
        (check) =>
          !check.is_bookable || !check.has_schedule || check.service_links < 1
      ) ||
      !['arrived', 'confirmed', 'waiting', 'no_show'].every(
        (key) => analyticsOutcomes[key] > 0
      ))
  ) {
    throw new Error(`${profile.id}: post-write audit failed`);
  }
}

async function curate(profile) {
  const session = await new HostedMcpSession({
    token: process.env.ALTEGIO_USER_TOKEN,
    companyId: profile.id,
  }).initialize();
  log('location_start', {
    location_id: profile.id,
    title: profile.title,
    mode: APPLY ? 'apply' : 'audit-only',
  });
  try {
    await ensureLocation(session, profile);
    const categories = await ensureCategories(session, profile);
    const staff = await ensureStaff(session, profile);
    const services = await ensureServices(session, profile, categories, staff);
    await ensureSchedules(session, profile, staff);
    await ensureBookingForm(session, profile);
    const { plan, failures, validation } = await ensureAppointments(
      session,
      profile,
      staff,
      services
    );
    if (APPLY && failures.length > 3)
      throw new Error(
        `${profile.id}: too many appointment failures (${failures.length})`
      );
    const visibilityRepairs = await repairAppointmentScheduleVisibility(
      session,
      profile,
      staff,
      services
    );
    const salesFailures = await ensurePaidSales(
      session,
      profile,
      staff,
      services
    );
    if (APPLY && salesFailures.length > 3)
      throw new Error(
        `${profile.id}: too many sales failures (${salesFailures.length})`
      );
    const auditSession = await new HostedMcpSession({
      token: process.env.ALTEGIO_USER_TOKEN,
      companyId: profile.id,
    }).initialize();
    try {
      await audit(auditSession, profile, staff, services, plan, {
        ...validation,
        visibility_repairs: visibilityRepairs,
      });
    } finally {
      await auditSession.close();
    }
    log('location_complete', { location_id: profile.id });
  } finally {
    await session.close();
  }
}

const selected = requestedId
  ? profiles.filter((profile) => profile.id === requestedId)
  : profiles;
if (selected.length === 0)
  throw new Error(`Unknown demo location ${requestedId}`);
for (const profile of selected) await curate(profile);
