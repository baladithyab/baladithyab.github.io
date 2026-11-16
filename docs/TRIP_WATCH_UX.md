# Trip Watch lab: experience design

> **Status: proposed. Nothing in this document is built.** It is the companion
> to [TRIP_WATCH.md](TRIP_WATCH.md), which covers data sources, architecture and
> schema. This document covers what people do with the tool. It draws on the
> owner's stated goal and on two private planning notes read on 2026-11-16.
> Those notes are not linked or quoted here.

## The problem

Friend-group trips mostly fail before anything is booked. Someone suggests a
place, the chat agrees it would be great, and nobody turns that into dates and
a destination. The goal is a planner that:

1. gets a group from a loose idea to one shared decision;
2. then lets each person add their own details, which will differ: different
   flights, different arrival days, sometimes different places to stay;
3. shows who wants to do what, so the group can see what to do together, what
   to split up for, and what someone does alone;
4. removes uncertainty about timing, transit and reservations by fetching what
   can be fetched;
5. keeps watching prices, before booking and after.

The first is the hardest, so it comes first in the build. The rest is easier
once a decision exists.

## Principles

| Principle | Why | In the product |
| --- | --- | --- |
| One small ask at a time | "So what's the plan?" is where group trips stall | Each person sees one card: the next thing the trip needs from them |
| Answer before signing up | Every step before the first answer loses people | A personal link is enough to say in or out, give dates, vote and pick interests |
| Decisions close | Groups reopen settled questions | Every group question has a closing time and ends as a line in the decision log |
| One plan, with names on it | People's details differ and overlap | Every item lists who is on it. Nobody has a separate itinerary |
| A real option behind every need | A plan made of placeholders is not a plan | "A flight for two from SFO" is a live search with a price from the moment it exists |
| Say what is still open | Stress comes from not knowing what is unsettled | Gaps, unbooked reservations and conflicts are one visible list |
| The group chat is the channel | The tool cannot post into a private chat | Every state has a two-line summary to paste, with the link |

## The journey

The stage names are the trip `stage` values in the schema.

```mermaid
flowchart LR
  IDEA["Idea: who is in, when, from where"] --> SHORT["Shortlist: priced options and a vote"]
  SHORT --> LOG["Decision logged"]
  LOG --> TRAVEL["Plan: each person's flight and stay"]
  LOG --> DO["Plan: ideas, interests, reservations"]
  TRAVEL --> BOOKED["Booked: arrivals, day grid, price drops"]
  DO --> BOOKED
```

| Stage | The group's question | What each person does | What the tool does | Ends when |
| --- | --- | --- | --- | --- |
| Idea | Is this happening, and roughly where and when? | Says in, maybe or out. Marks the dates that work. Picks a budget band. Names a home airport. | Shows who has answered. Finds the dates most people share. Searches "anywhere" from every home airport and ranks destinations by the group's total. | The organizer puts two to four options to a vote |
| Shortlist | Which one? | Approves every option that works and marks one favourite | Prices each option per person: their own flight from their own airport, plus a share of the stay. Shows who cannot make each one. | The poll closes and the organizer locks the result into the decision log |
| Plan | How does each of us get there, where do we sleep, and what do we do? | Picks a flight from the candidates in their slot. Joins a stay. Adds ideas and sorts them into three buckets. | Proposes slots from gaps. Ranks ideas by overlap. Flags what must be booked, by when and by whom. Watches every price. | Flights and stays are booked |
| Booked | Is anything left to chance, and can we get money back? | Records what they paid. Books the reservations they lead. | Arrivals board, day grid, issues. Watches booked prices and says when a drop can be captured and how. | The trip ends |

## Screens

Seven places, all under `/lab/trips/[id]` except the join page. The names in
the sketches are made up.

### Trip home

The page a member lands on. It answers three questions: what do I need to do,
who are we waiting for, and what is already settled.

```text
Lisbon in May                             Idea > Shortlist > [Plan] > Booked
-----------------------------------------------------------------------------
YOUR NEXT STEP
  Pick your flight. 3 options from SFO, cheapest $868.         [ See options ]

WAITING ON
  Priya   dates, vote           Sam   flight
  Dev     all set               Mei   has not opened the link   [ Copy nudge ]

DECIDED
  12 Nov  Lisbon, 10 to 17 May. 5 of 6 approved.
  14 Nov  One apartment for the first four nights.
```

"Copy nudge" puts a short message on the clipboard for the group chat, such as
"Lisbon in May: waiting on Priya (dates, vote) and Sam (flight). The vote
closes Friday." followed by the trip link.

### Join

What a personal link opens. One phone screen, no account.

```text
Maya invited you to Lisbon in May

  Are you in?         ( In )   ( Maybe )   ( Out )
  Dates that work     [ calendar: drag across the days you can do ]
  Budget              ( $ )   ( $$ )   ( $$$ )
  Flying from         [ SFO                ]
                                                               [ Done ]
```

### People

Every member with their answers and how far along they are: flight (none,
searching, chosen, booked), stay, and the reservations they lead. The owner
adds placeholder members and copies personal links here.

### Options

The Shortlist stage. One card per option, priced for each person.

```text
A   Lisbon, 10 to 17 May                               group total $7,420
    You $1,310    Priya $1,090    Sam $1,640    Dev $1,480    Maya $1,900
    Cannot make it: Mei (has to be back on the 14th)
    Approved by 4, favourite of 2             [ Works for me ] [ Favourite ]
```

### Plan

The day grid, with a column per member. Wide cells are shared items.

```text
              You          Priya        Sam          Dev
Sat 10 May    fly SFO-LIS  fly SFO-LIS  .            fly JFK-LIS
              Apartment    Apartment    .            Apartment
Sun 11 May    [ Sintra day trip       ] .            Surf lesson
Mon 12 May    Apartment    Apartment    fly ORD-LIS  Apartment
              [ Dinner at 20:00, booked: everyone                  ]
```

Above the grid sit two short lists:

- **Arrivals.** Who lands when and where. Landings at the same airport within
  an hour of each other are grouped, so people can share a ride.
- **Issues.** Someone on an activity before they have arrived, nights without
  a stay, two things at once, a reservation with no one booking it.

### Ideas

A board with three columns: reservation needed, want to do, would like to do.
The column a card sits in is the viewer's own choice for it. The count shows
how many of the group are interested.

```text
            Reservation needed      Want to do            Would like to do
Everyone    Fado dinner   5 of 6    Sintra       2 of 6   Tile museum  1 of 6
            book by 20 Apr (Sam)    breakout
Mine        Fado dinner             Surf lesson           Tile museum
```

Opening a card shows who is interested and how strongly. "Join" picks a bucket
for the viewer. "Schedule" puts the idea on a day with the interested members
on it. Below the board, each person sees how much of their own list made it:
"3 of your 4 reservation-needed ideas are scheduled."

### Prices

Every watch with its chart. For a booked item it shows the price paid against
the price now, and a card when a drop can be captured.

## How the group mechanics work

### The next step

`nextAsks` returns what the trip needs from one member, in this order:

1. whether they are in;
2. the dates that work;
3. a home airport;
4. open polls they have not voted in, soonest closing first;
5. their slots that have candidates and no choice;
6. reservations they lead, soonest book-by date first.

Nothing is stored for this. It is recomputed from the trip, so an ask
disappears the moment it is answered. "Waiting on" is the same function run
for every member.

### Polls and decisions

- **Voting is approval plus one favourite.** A member approves every choice
  that works for them and may mark one favourite. Choices are ordered by
  approvals, then by favourites. This asks "what can you live with" before
  "what do you want most", which is the question that unblocks a group.
- **A poll has a closing time.** A day before, members who have not voted get a
  reminder if they have a notification channel, and the organizer gets a nudge
  to paste.
- **Closing does not decide.** The owner locks the result, which writes a line
  in the decision log. A tie, or a late "I cannot make that week", needs a
  person. The leading choice is shown as what will be locked.
- **Locking an options poll** marks the winning option chosen and the others
  rejected, which pauses their watches, and moves the trip to the Plan stage.
- **Reopening is explicit.** Changing a decision adds a new line that replaces
  the old one. Both stay visible.

### Interests

- Each member's bucket for an idea is their own. The same dinner can be
  "reservation needed" for one person and "would like to do" for another.
- Ideas are ranked by a score: 3 for each reservation-needed, 2 for each want,
  1 for each would-like. The top of the list is what most people care most
  about.
- When an idea is scheduled, the members interested in it become its
  participants. If that is everyone who is coming, it is a group activity. If
  it is some of them, it is a breakout. If it is one, it is a solo plan. The
  label describes who is on it; nobody is added to something they did not pick.
- If anyone put an idea under reservation needed, the card asks for a book-by
  date and for the member who will book it.

### Arrivals

Arrival and departure times come from chosen and booked flight items. Until a
member has chosen a flight, the board shows their slot's dates and marks the
time as unknown.

## After booking: capturing a price drop

Several consumer services watch a booking and try to recover the difference
when the price falls. Their own pages, read on 2026-11-16, say:

| Service | What it does | How it learns of a booking | Cost |
| --- | --- | --- | --- |
| [Axel](https://helloaxel.com/en/faq/flight-repricing) | Books flights and hotels itself, then watches the fare and asks the airline to reprice on a drop. The saving usually comes back as airline credit. It does not change a booking without approval. | The trip is booked through Axel | 25% of the saving, or a membership ($15 the first month, then $10 a month) and no cut |
| [Autopilot](https://withautopilot.com/flights) | Tracks the fare of an existing reservation and claims the lower fare from the airline, keeping the same flights and confirmation number | Connect an inbox, forward the confirmation email, or enter it by hand | 25% of the saving; Pro is $9.99 a month |
| [Soar Travel](https://joinsoar.co/) | A travel assistant that reads bookings from an inbox to plan and manage trips. Its pages read here do not describe price-drop capture. | Connect Gmail, or forward a booking | Free during its beta |

None of the three publishes an API, so none can be plugged into this tool. A
different company, Soar Flights, runs an MCP endpoint for flight search and
booking; it is unrelated to Soar Travel and has not been evaluated as a source.

What this design does itself:

1. **Record the booking's facts on the item.** What was paid, who sold it
   (airline, agency or hotel), the fare or rate type, and the last day of free
   cancellation. No confirmation numbers and no logins.
2. **Keep the exact watch running.** The `below_paid` rule fires when the same
   flight or room costs less than was paid.
3. **Look the supplier up in a capture registry.** One entry per supplier says
   whether a drop can be captured, how, what comes back (refund, credit or
   points), what is excluded, where the supplier says so, and when that was
   last checked. The registry is a JSON file in the repository.
4. **Say what to do.** The alert gives the saving, what the member would get
   back, the steps and any deadline. For a hotel with free cancellation the
   steps are to book the lower rate first and cancel the old booking second.
   A supplier with no entry gets "no policy on file" and a link to its fare
   rules. A supplier that does not allow it gets no alert.
5. **Offer a hand-off.** A member who would rather not do it themselves gets a
   link to a capture service. The tool sends that service nothing.

The tool never holds an airline login or inbox access, and never changes a
booking.

A research pass found published support for capturing a drop on United,
Southwest and Alaska (not its cheapest fare type), and a published refusal on
Ryanair. Those pages could not be re-fetched for this document, and most other
airlines, agencies and hotel groups had no clear published answer. The registry
therefore starts empty, and each entry is added with its source and the date it
was checked.

## Where the earlier notes land

The private notes describe a larger product than this lab. This is where each
part of them lands.

| In the notes | Here | Why |
| --- | --- | --- |
| Three priority buckets per person, with overlap detection | Phase 5, as an interest on each idea | It is the core of group planning and costs one column |
| Real transport options that shape the plan | Phases 1 to 3, flights and stays | Rail, bus and ferry have no evaluated source yet |
| Roles, polls and a decision log | Phase 2, with three levels (guest, member, owner) instead of five roles | "Day captain" becomes the member who leads an item; "viewer" is a guest who does not answer |
| Budget band and cost estimates | The band is one of the first answers; cost per member comes from real prices | An expense ledger is left to tools that already do it |
| Itinerary canvas with a map | The day grid, without a map | The grid answers "who is where"; a map can be added to it |
| Day packing from opening hours and travel times | Phase 7. Until then the tool only reports conflicts | It needs routing and opening-hours sources that have not been evaluated |
| Pulling ideas out of social and video links | Phase 7. Until then: paste a link and type a title | Fetching those sites automatically runs into their terms, and extraction costs a model call per link |
| Local guidance per city | Phase 7 | Generated advice about transit and safety has to be checked against something |
| A chat assistant with tools | Phase 7 | The API is already a set of small operations and can be exposed as tools without redesign |
| On-trip "now and next" and offline use | Phase 7 | The Booked stage's arrivals board is the first step toward it |
| Calendar and PDF export | Phase 7, calendar first | |
| A multi-service backend | Not adopted | One Worker and one D1 database are enough for friend groups |

## Not decided

1. **What a guest can see.** A personal link currently shows the whole trip,
   including prices. Showing a guest only the questions and the options would
   leak less if a link is forwarded, and would make the page less useful.
2. **Whether a poll should lock itself.** Stalling is the problem this tool
   exists for, which argues for locking the leader at the closing time. A late
   objection argues against. The design has the owner lock it.
3. **Bucket names.** The three names come from the notes. "Reservation needed"
   mixes two things, how much someone wants it and whether it must be booked.
   The schema keeps them apart (`interest` and `book_by`); the labels might
   follow.
4. **When a drop is worth an alert.** A credit that expires is worth less than
   a refund. The threshold is a setting, with no default chosen yet.

## Sources

Read first-hand on 2026-11-16 unless marked.

- Axel: [flight repricing](https://helloaxel.com/en/faq/flight-repricing) and
  [what Axel is](https://helloaxel.com/en/faq/what-is-axel).
- Autopilot: [flights](https://withautopilot.com/flights) and
  [pricing](https://withautopilot.com/pricing).
- Soar Travel: [home page](https://joinsoar.co/) and
  [which Soar](https://joinsoar.co/which-soar), which says Soar Flights Inc. is
  a separate business.
- Read by a research agent, not re-fetched: United
  [travel credits](https://www.united.com/en/us/fly/travel/trip-planning/travel-credit.html),
  Southwest
  [lower fare refund options](https://support.southwest.com/helpcenter/article/lower-fare-refund),
  Alaska [Saver fares](https://www.alaskaair.com/content/travel-info/flight-experience/saver),
  Ryanair
  [change costs](https://help.ryanair.com/hc/en-gb/articles/12891192262161-How-much-does-it-cost-to-change-my-flights),
  and the Soar Flights [MCP page](https://flysoar.ai/mcp).
- The two private planning notes were read in the owner's browser. They are the
  source of the bucket model, the decision log and the list in "Where the
  earlier notes land".
