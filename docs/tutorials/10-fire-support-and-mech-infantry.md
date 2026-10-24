# Tutorial 10: Fire support and mechanized infantry

**Time:** 20 minutes · **You will learn:** forward observers and call for fire,
manual fire missions, carrying infantry in vehicles, dismounting them for an
assault, and the *halt on contact* reaction.

The scenario: Red holds the town of **Calloway** with a rifle squad, and has a
BMP platoon 3 km behind it that will counterattack. Blue has:

- a **forward observer** team on high ground that can see the town;
- a **Paladin platoon** (four 155 mm howitzers) 9 km away at Brenham;
- a **Bradley platoon** carrying a **rifle squad**, starting at Alderford.

You will build it in the GUI first, then run the same thing as a script.

## 1. Place the forces (GUI)

Start the server (`npm start`), open <http://127.0.0.1:8080> and choose
**File → New scenario** with the default terrain.

1. **Red.** Choose **Red** in the Create panel and place an **RU Rifle Squad**
   on Calloway and an **RU Mech Platoon** about 3 km on the far side of the town
   from Alderford.
2. **The guns.** Choose **Blue** and place a **Paladin Platoon** on Brenham.
   Click one of the howitzers: under **Weapons** the *155mm M284 howitzer* shows
   39 rounds and a 22 km range.
3. **The observer.** Place a **Forward Observer Team** on a hill 2–3 km from
   Calloway. To check the view, select it and turn on **Layers → Weapon/sensor
   ranges**: its optics reach 6 km. In the inspector, **Reactions → Call for
   fire** is already *Yes* (observer teams start with it) and you can set
   **Rules of engagement → Hold fire** so it stays hidden.
4. **The mechanized team.** Place a **US Mech Platoon** and a **US Rifle Squad**
   at Alderford.

## 2. Mount the squad

Select the rifle squad (click its symbol, or the unit in **Objects**), then
right-click the Bradley platoon. The menu offers:

- **Mount US Mech Platoon**: the soldiers walk to the vehicles and board;
- **Put inside US Mech Platoon now**: they are inside immediately, which is what
  you want when setting up a scenario.

Choose **Put inside … now**. The squad disappears from the map, and its
activity reads **MOUNTED 9/9**. Zoom in (or set **Layers → Units: entities**)
and the first two Bradleys are labelled **+6** and **+3**: six seats per
Bradley. Selecting the platoon shows **Passengers 9/24** with a **Dismount**
button.

## 3. Orders

**Bradley platoon.** Select it and build a plan in the **Plan editor**:

| Step | Value |
| --- | --- |
| Set formation | column |
| Move to (pick) | a point 1.5 km short of Calloway (the dismount point) |
| Dismount passengers | |
| Set formation | line |
| Wait (seconds) | 120 |
| Move to (pick) | 700 m short of the town |

Name it *Carry and support* and press **Assign plan**.

**Rifle squad.** Select it in **Objects** and set **Reactions → On contact →
Halt and fight**. Then give it a task even though it is riding: **Move to…** and
click Calloway. A passenger's orders wait until it is out of the vehicle, so the
squad will start its assault the moment the Bradleys drop it off.

**Red counterattack.** Select the BMP platoon, set **On contact → Halt and
fight**, and give it a plan: **Wait until time** 540, then **Move to** Calloway.

## 4. Run it

Press **Run** at 4× or 8× and watch the event log (tick **tasks** and
**kills**):

- Within a second the observer spots the town and calls the guns:
  *FO … called for fire on Red Squad 2: Steel Rain firing 3 rounds x 4 tubes*.
  After the 20-second lay and about 30 seconds of flight, the rounds land as
  scaled bursts on the map and the howitzers flash at Brenham.
- The observer calls again every minute while it has targets. It also finds the
  BMPs waiting behind the town.
- The Bradleys reach the dismount point and unload: *6 passengers dismounted
  from …*. The squad walks towards the town.
- At 9 minutes the BMPs come forward, halting whenever they make contact.

Two rules keep the guns off your own troops: the observer never calls within
**150 m of friendly troops** (danger close), and never twice on the same spot
while rounds are in the air. See [Concepts → Indirect fire](../concepts.md#indirect-fire-and-call-for-fire).

## 5. The same thing as a script

[`examples/combined-arms.mjs`](../../examples/combined-arms.mjs) builds exactly
this scenario through the REST API. It finds the observation post by asking the
terrain service for the highest point 2–3.5 km out that has line of sight to the
town, mounts the squad with `POST /units/{id}/embark`, gives the orders above,
runs 30 minutes and prints the after-action report:

```bash
npm start &
node examples/combined-arms.mjs
```

```
Objective Calloway; attack from Alderford (5.8 km); guns at Brenham (9.1 km)
FO Hawk at (5208, 12093), 243 m, 2.8 km from Calloway; reactions {"callForFire":true}
1st Squad: 9 of 9 mounted in Team MECH (6 seats per Bradley)
  00:00:01  FO Hawk called for fire on Red Squad 2: Steel Rain firing 3 rounds x 4 tubes
  00:00:49  Red Squad 5 destroyed by Steel Rain Lead
  00:00:50  Red Squad 8 destroyed by Steel Rain 4
  00:01:01  FO Hawk called for fire on Red Mech Lead: Steel Rain firing 3 rounds x 4 tubes
  00:01:04  Red Squad 6 destroyed by Steel Rain 3
  ...
  00:05:56  Red Mech 2 destroyed by Steel Rain 3
  ...
  00:07:28  6 passengers dismounted from Team MECH Lead
  00:07:28  3 passengers dismounted from Team MECH 2
  ...
  00:12:01  Team MECH: plan Carry and support complete
  00:12:11  Red Squad 4 destroyed by Team MECH 2
  00:13:25  Red Mech Lead: halted on contact
  00:13:33  1st Squad 3 destroyed by Red Mech Lead
  00:13:47  1st Squad Lead destroyed by Red Mech Lead
  ...
  00:14:43  1st Squad 9 destroyed by Red Mech Lead
  ...
  00:16:55  Red Mech Lead destroyed by Team MECH 2

After-action review
  Blue  12/18 left, 9 kills, 176 rounds fired
  Red    2/11 left, 6 kills, 30 rounds fired
  Kills by weapon: how-155mm 7, gun-30mm-2a42 6, gun-25mm 1, atgm-tow 1
  Artillery rounds: 156
```

The artillery breaks up the squad in the town: it kills six of the nine
riflemen, and the shelling pins the rest down again and again, so the squad
breaks and falls back several times (the full event log shows *pinned down* and
*broke and is falling back*). It also destroys one BMP and immobilises another
3 km out, long before contact. But the last BMP catches the dismounted squad in
the open and kills six of them with its 30 mm cannon before the Bradleys
destroy it. One Red rifleman survives on the east edge of the town. Run it
twice: the result is the same each time, because the simulation is
deterministic.

## 6. Manual fire missions

You do not need an observer to use artillery. Select the Paladin platoon (or
one howitzer, or a mortar team) and either:

- right-click empty ground → **Fire mission here (3 rounds)**, or right-click a
  hostile → **Fire mission on *name***;
- in the inspector, set **Fire *n* rounds** and press **Fire mission…**, then
  click the target;
- in a plan, add **Fire mission (pick), rounds**.

Through the API (in both the GUI build above and the script, the Paladin
platoon is `U3`):

```bash
curl -X POST localhost:8080/api/v1/units/U3/task -H 'Content-Type: application/json' \
  -d '{"type": "fireMission", "target": {"town": "Calloway"}, "rounds": 4, "radius": 100}'
```

`radius` spreads the rounds over an area (a sheaf). A target inside the
weapon's minimum range (2 km for 155 mm) fails with *target out of range* in the
event log, and a unit without artillery with *no indirect-fire weapon*.

## 7. Things to try

- **Mortars.** Replace the Paladins with a **US 81mm Mortar Section** 3 km from
  the town. They are lighter (25 m burst, almost useless against armour) but
  closer and faster to fire.
- **Air assault.** Place a **UH-60M Black Hawk**, give it **Set altitude** 0 so
  it lands, and order a rifle squad to **Mount** it. Then plan: **Set altitude**
  60, **Move to** a landing zone, **Dismount passengers** (the helicopter sets
  down by itself), and the squad's own order takes over.
- **Lose the carrier.** Let the BMPs catch the Bradleys before the dismount
  point. When a carrier is destroyed, about half its passengers die with it and
  the rest bail out (*… bailed out of …*).
- **Review it.** Press **AAR** to replay the fight and open the report
  ([Tutorial 11](11-exercise-control-and-aar.md)).
