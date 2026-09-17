import type { Segment } from "./script";
import { withImageKey } from "./keys.server";
import { textChat } from "./text-engine.server";
import { assertActive, killableSignal, KilledError } from "./kill-switch.server";

const PIXAZO_URL = "https://gateway.pixazo.ai/flux-1-schnell/v1/getData";
// Generation can legitimately take minutes when the renderer is busy. A short
// deadline used to kill healthy renders at 60s and made long runs look stuck,
// so this is only a very generous safety net, never a fast-fail.
const IMAGE_REQUEST_TIMEOUT_MS = 1_800_000;

/**
 * Renderer-only art direction. The writing model describes only scene content;
 * this exact block is added at the final Pixazo request for every image.
 * Flux has no negative-prompt channel, so this stays entirely positive: naming
 * unwanted media such as photography or pencil sketches can make Flux draw them.
 */
export const STYLE =
  "FIXED VISUAL STYLE: vivid full-colour shonen fighting manga artwork of a magical fantasy world, heavy bold black ink linework " +
  "with dramatic hatching, screentone and halftone comic shading, deep cross-hatched shadows, explosive glowing energy and aura effects, " +
  "motion speed lines on attacks, expressive manga facial design, consistent character proportions, " +
  "intensely saturated jewel-tone colours with glowing magical light, dramatic comic-panel composition, " +
  "richly detailed fantastical backgrounds, sharp finished colour-manga illustration";

/**
 * The single authoritative light statement for every panel: natural, faithful
 * to the script, and always readable. Deliberately neutral — no darkness, no
 * mystery, no mood grade.
 */
export const TONE_LOCK =
  "LIGHTING: natural, clear and well-exposed, exactly as the scene describes (bright daylight stays bright, " +
  "a night scene is a well-lit night scene); faces, eyes and every environment detail are fully visible";

/**
 * Flux has NO negative prompt: every noun written here is a token the model can
 * draw. Long "no speech bubbles, no posters, no billboards..." lists were being
 * rendered literally (walls of speech bubbles and signage). So the guards are
 * now short and phrased POSITIVELY wherever possible.
 */
export const NO_TEXT_GUARD =
  "a pure wordless artwork, completely free of any text, lettering, signage, speech balloons or captions";

/** Single-image guard. Deliberately short; see NO_TEXT_GUARD note above. */
export const SINGLE_PANEL_GUARD =
  "one single full-bleed illustration of this one moment, one continuous scene edge to edge, fully drawn and detailed";

/** Added only when the scene has no people in it. */
export const NO_PEOPLE_GUARD =
  "an empty environment shot with no people, no figures and no characters anywhere in frame";

/** Added only when the scene does have named/described people. */
export const CAST_GUARD =
  "only the described cast is present, each person drawn once with their stated identity";

/**
 * Anatomy guard. Panels came back with two figures sharing one shirt and fused
 * torsos, so every body is now explicitly stated to be whole and separate.
 */
export const ANATOMY_GUARD =
  "anatomically correct bodies, one head, two arms and two legs per person, every figure a complete separate body with its own clothing, clearly spaced apart, never fused, merged, overlapping into one another or duplicated";

/**
 * Every text call in the app goes through Z.ai GLM (glm-4.7-flash)
 * (see zai.server.ts): one request at a time, with an automatic retry on
 * the next key when a daily free-model quota runs out. No other provider is
 * used anywhere in this app.
 */
export { textChat };

function stripFences(s: string): string {
  return s
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
}

/**
 * Forgiving reader for the prompt-writing answer.
 *
 * The free model kept refusing to emit a strict JSON array (unescaped quotes,
 * trailing prose, half-closed brackets), so the whole chunk was thrown away and
 * no panels ever appeared. The writing step now asks for plain "n) prompt"
 * lines and this parser accepts almost anything shaped like that:
 *
 *   - "1)" / "1." / "1:" / "1 -" / "[1]" / "Prompt 1:" numbering
 *   - leftover bullets, quotes, brackets, commas and code fences
 *   - a stray JSON array (parsed as such when it happens to be valid)
 *   - continuation lines, which are appended to the prompt above them
 *
 * Returns a sparse array indexed by (number - 1). Unnumbered output falls back
 * to reading the non-empty lines in order.
 */
export function parseNumberedList(raw: string, expected: number): string[] {
  const text = stripFences(raw);

  // If the model did return valid JSON after all, take it.
  const s = text.indexOf("[");
  const e = text.lastIndexOf("]");
  if (s !== -1 && e > s) {
    try {
      const parsed = JSON.parse(text.slice(s, e + 1)) as unknown;
      if (Array.isArray(parsed) && parsed.some((v) => typeof v === "string" && v.length > 30)) {
        return parsed.map((v) => (typeof v === "string" ? clean(v) : ""));
      }
    } catch {
      /* not JSON — fall through to the line reader */
    }
  }

  const out: string[] = [];
  const loose: string[] = [];
  let last = -1;
  const numbered = /^\s*(?:prompt\s*)?[[(]?(\d{1,3})[\])]?\s*[).:\-–—]\s*(.*)$/i;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = numbered.exec(line);
    if (m) {
      const n = Number(m[1]);
      const body = clean(m[2] ?? "");
      // Guard against a stray number inside prose restarting the list.
      if (n >= 1 && n <= expected + 5) {
        out[n - 1] = body;
        last = n - 1;
        continue;
      }
    }
    if (last >= 0) {
      // Continuation of the previous prompt (the model wrapped a long line).
      out[last] = `${out[last] ?? ""} ${clean(line)}`.trim();
    } else {
      loose.push(clean(line));
    }
  }

  const got = out.filter((v) => v && v.length > 30).length;
  if (got === 0 && loose.length > 0) {
    return loose.filter((v) => v.length > 30);
  }
  return out;
}

/** Strips leftover quoting/bullet punctuation from one recovered prompt. */
function clean(v: string): string {
  return v
    .replace(/^[\s*•\-–—]+/, "")
    .replace(/^["'`“”]+/, "")
    .replace(/["'`“”]?\s*,?\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Builds a compact, reusable character bible from the script.
 *
 * Only the OPENING portion of the script is sent: characters are introduced in
 * the first scenes, so the head alone is enough to fix their look, and it keeps
 * the request far inside the free model's context window (a multi-hour script
 * would otherwise come back as a hard 400). Budgets shrink on each retry.
 * It never throws: an empty bible only costs some consistency, while a throw
 * would kill the whole storyboard for a long script.
 */
export async function buildCharacterBible(script: string): Promise<string> {
  const system =
    "You are a character continuity editor. Read the WHOLE script (it may be " +
    "Hinglish/Hindi) and list the recurring characters. For each, give ONE compact English line of FIXED, highly " +
    "specific visual traits usable verbatim inside an image prompt: age, gender, exact hair colour + length + style, " +
    "eye colour, skin tone, face shape, one distinguishing feature (scar, mole, glasses, bandage), build/height, and " +
    "signature clothing WITH exact colours. Be concrete — these traits must let an artist redraw the same person " +
    "hundreds of times identically. 16-28 words per character. Max 10 characters. " +
    "After the characters, add up to 6 recurring LOCATIONS the same way, one line each, prefixed 'Place - ', with " +
    "fixed visual details (materials, colours, key furniture/landmarks, time of day if fixed) so the same place is " +
    "drawn identically every time it appears, e.g. 'Place - Henan's home: small brick village house, blue wooden " +
    "door, clay-tiled roof, neem tree in the yard, string cot outside'. " +
    "CRITICAL: determine each character's gender from the script (names, pronouns, relationships like brother/sister) " +
    "and make the gender the FIRST and most emphasized trait — write 'male' or 'female' explicitly plus a matching " +
    "noun (man/woman/boy/girl). Never guess wrong or leave gender ambiguous. " +
    "CRITICAL: determine each character's AGE from the script (school grade, job, parenthood, being called old/young, " +
    "family roles like grandfather/mother/child) and state it EXPLICITLY right after the gender: a number " +
    "('17 years old', '45 years old') or an exact band ('elderly, over 65', 'middle-aged, 40 to 55', 'teenager', " +
    "'young child'). Never leave age vague or write just 'young'/'old' — write the concrete age. " +
    "LEAD CHARACTER OVERRIDE (absolute): the story's main protagonist must always be a clearly adult, unmarried " +
    "23-year-old young man, even if the script is vague or suggests a teenage boy. Put the protagonist FIRST and " +
    "describe him exactly as 'male, 23-year-old unmarried young man' — never boy, teenager, schoolboy or child. " +
    "Output plain lines like: Henan: male, 17-year-old Indian boy, messy jet-black hair, dark brown eyes, tan skin, " +
    "thin wiry build, faded grey school shirt with frayed collar, small scar above left eyebrow. " +
    "No headings, no numbering, no extra commentary.";

  // A server function cannot pass Z.ai' streamed bytes through to the browser;
  // the published request therefore looks idle until the whole answer is ready.
  // Keep the call bounded, while sampling the whole story so characters first
  // introduced late are still represented.
  const body = representativeScript(script, BIBLE_INPUT_CHARS);

  try {
    const out = await textChat(system, `FULL SCRIPT:\n${body}`, {
      temperature: 0.4,
      maxOutputTokens: 4_000,
      timeoutMs: 1_800_000,
      attempts: 2,
    });
    const bible = normalizeLeadCharacter(stripFences(out).slice(0, 4000));
    if (bible.length > 20) return bible;
  } catch (e) {
    if (e instanceof KilledError) throw e;
    console.error("buildCharacterBible failed, continuing without a bible:", e);
  }
  return "";
}

/**
 * The first character line is the lead. Product direction fixes that person as
 * an adult 23-year-old unmarried man, including user-written sheets, so a model
 * can never reinterpret a vague "young" protagonist as a 14–16-year-old boy.
 */
export function normalizeLeadCharacter(bible: string): string {
  const lines = bible.split("\n");
  const leadIndex = lines.findIndex((line) => {
    const clean = line.replace(/^[\s\-*•\d.)]+/, "").trim();
    if (!clean.includes(":")) return false;
    return !/^(?:place|location|setting)\s*-/i.test(clean);
  });
  if (leadIndex < 0) return bible;

  const line = lines[leadIndex] as string;
  const colon = line.indexOf(":");
  if (colon < 1) return bible;
  const name = line.slice(0, colon).trim();
  let traits = line.slice(colon + 1).trim();
  traits = traits
    .replace(/\b(?:male|female)\s*,?\s*/gi, "")
    .replace(/\b\d{1,2}\s*(?:-|\s)?(?:to|–|-)?\s*\d{0,2}\s*(?:-|\s)?years?[- ]old\s*/gi, "")
    .replace(/\b(?:teenage[rd]?|adolescent|schoolboy|schoolgirl|boy|girl|child|kid|young woman|woman|man)\b\s*,?\s*/gi, "")
    .replace(/\b(?:married|unmarried|single|bachelor)\b\s*,?\s*/gi, "")
    .replace(/^\s*[,;-]+\s*|\s{2,}/g, " ")
    .trim();
  lines[leadIndex] = `${name}: male, 23-year-old unmarried young man${traits ? `, ${traits}` : ""}`;
  return lines.join("\n");
}

const PROMPT_SYSTEM =
  "You are a storyboard writer. Describe scene CONTENT only; do not name or request any art style, medium, rendering " +
  "technique or visual genre because the image renderer applies one fixed style separately. You are given a " +
  "character bible and the COMPLETE script (Hindi/Hinglish/English), every line numbered with its timestamp. You are " +
  "then asked for a set of line numbers. For EACH requested number write ONE English image prompt that draws EXACTLY " +
  "WHAT THAT LINE LITERALLY DESCRIBES.\n" +
  "TIMESTAMP FIDELITY (absolute): the prompt for a numbered line must show THAT line's own moment and action. Never " +
  "draw a different timestamp or blend two timestamps into one image. Story continuity is equally absolute: unless " +
  "that line explicitly changes place, time or cast, retain the established location, time of day and active characters " +
  "from the immediately preceding lines. A new sentence is not a new scene. Resolve Hindi/Hinglish pronouns such as " +
  "वह, उसके, उसकी, उसे, उन्होंने and English he/she/they from the surrounding lines and write the resolved character's " +
  "NAME in the prompt. Never replace an active character with an empty room or landscape.\n" +
  "EVERY prompt must contain, in this order: (1) the place/setting the line itself describes, (2) who or what is in " +
  "frame — with bible traits woven inline ONLY for characters the line itself is about; if the line involves no person, " +
  "the shot has no people at all, (3) the exact action, body pose and facial expression, (4) 4-6 concrete environmental " +
  "details, (5) the camera angle and shot size (extreme close-up / close-up / medium / wide / low angle / high angle / " +
  "over-the-shoulder), (6) the natural lighting and colour the line implies.\n" +
  "RULES:\n" +
  "- LEAD CHARACTER AGE (absolute): the FIRST character in the bible is the main protagonist. He is always a clearly " +
  "adult, unmarried 23-year-old young man. Repeat that exact age and adult status whenever he appears; never call or " +
  "depict him as a boy, teenager, schoolboy, child, or 14–16 years old.\n" +
  "- ONE LINE = ONE IMAGE (absolute): exactly one prompt per requested number, in the same order, never merged, never " +
  "split, never skipped, never a placeholder. Each prompt must be visibly DIFFERENT from its neighbours.\n" +
  "- NOTHING INVENTED (absolute): every person, place, object, prop and event in the prompt must come from the script — " +
  "from the requested line itself, from its neighbouring lines, or from the character bible. Never invent a room type, " +
  "building, institution, machine, vehicle, furniture, clock time, weather or event the script never mentions (no " +
  "'investigation room', 'office', 'laboratory' or similar unless the script says so). If the line does not state a " +
  "place, reuse the last place the SCRIPT itself stated — never a new one you made up. Before writing, translate the " +
  "Hindi/Hinglish line to yourself and make sure every noun and verb of that translation is visible in your prompt; if " +
  "your prompt could not be recognised as a drawing of that exact line, rewrite it.\n" +
  "- LITERAL SUBJECT (the most important rule): draw the visible event happening at THAT timestamp and nothing else. " +

  "First classify the line. If a named person says, tells, explains, warns, asks, answers, thinks, remembers or learns " +
  "information, show that present speaker/listener interaction and its emotion — DO NOT illustrate nouns inside their " +
  "speech or thought as if those events are happening now. For example, a woman warning someone about an army shows " +
  "the woman warning them in the established room, not a lineup of soldiers. Only draw demons, a massacre, a city, " +
  "an army, a war or a past event directly when the timestamp explicitly presents it as visible action, a clearly " +
  "introduced flashback, or detached historical narration with no present speaker. Never replace a conversation with " +
  "the topic being discussed.\n" +
  "- SCENE CONTINUITY: default to the same location, time and active cast as the previous line. Change them ONLY when " +
  "the current line explicitly names a different location/time/cast or clearly begins a flashback, memory, dream or " +
  "separate narrated event. Keep continuing actions spatially coherent: the same room layout, doors, furniture and " +
  "character positions should remain recognisable while pose, expression and camera angle advance.\n" +
  "crowds, villagers, strangers or unnamed people show THOSE people — never insert a main character into them.\n" +
  "- CAST RESOLUTION: put every bible character named in the current line in frame. Also retain a bible character when " +
  "the current line uses a pronoun or continues that character's action from the preceding line. Write every resolved " +
  "character by NAME and repeat their sheet traits. Lines explicitly about soldiers, demons, crowds, villagers, " +
  "strangers or unnamed people show those people instead of unrelated main characters.\n" +
  "crowds, villagers, strangers or unnamed people show THOSE people — never insert a main character into them.\n" +
  "- A memory, flashback, dream or story-within-the-story is drawn as the remembered event itself, in the place and " +
  "time it happened, not as someone remembering it.\n" +
  "- LIGHTING & COLOUR: take the lighting ONLY from the line — daytime is bright natural daylight, an indoor scene is " +
  "a well-lit room, a night scene is a clearly lit night with visible detail. Never add darkness, gloom, shadowy " +
  "mystery, fog or noir the line does not state. Name the light source and the dominant colours.\n" +
  "- RICH DETAIL (critical): every prompt is dense with concrete visual detail — at least 4-6 specific drawable things " +
  "in the environment; for each person the posture, hand position, exact expression (eyes, eyebrows, mouth) and " +
  "clothing state. Foreground, midground and background must each have something drawn in them.\n" +
  "- STAGING & GAZE (critical): write candid in-story staging. State where each person looks — at the other character, at the object they hold, or at what the line says they see — and give each body a three-quarter or profile orientation inside the scene. People are absorbed in the action; nobody poses for the viewer or stares straight out of the frame unless the line itself says they look at us.\n" +
  "- ALWAYS A SCENE, NEVER A DESIGN: every prompt is one continuous location with a full background — floor, walls or ground, sky or ceiling, and 4-6 props. Never write a reference sheet, model sheet, character design, turnaround, multiple views, a lineup, a floating head, an isolated portrait on a plain backdrop, a duplicated copy of the same character, or an empty blank background.\n" +
  "- CARRY THE SCENE FORWARD: begin from the place, time of day and cast already established by the previous lines, and say that place explicitly in this prompt even if the line does not repeat it.\n" +
  "- Weave a character's fixed traits INLINE (e.g. 'Henan, a thin 17-year-old boy with messy jet-black hair, sits...'). " +
  "NEVER write a separate character description block, sheet, reference, lineup or 'plus portrait of'.\n" +
  "- CONSISTENCY: when a bible character DOES appear, repeat their bible traits (hair, eyes, clothing colours) using " +
  "the bible's own words. Never redesign, re-age or re-dress a character between shots.\n" +
  "- THE CHARACTER BIBLE IS APPEARANCE REFERENCE ONLY. Never turn its wording into the panel's action, setting or " +
  "composition. The timestamped script alone decides what happens. First describe the exact visible story action and " +
  "location; attach fixed appearance traits only to the people actually present.\n" +
  "- NEVER SUBSTITUTE SCENERY FOR A HUMAN MOMENT: if a line names, quotes, remembers, describes, follows or uses a " +
  "pronoun for a person, that person must be visibly present performing the line's action. An empty room, empty road, " +
  "empty field or landscape is valid only when the line explicitly establishes an unoccupied place.\n" +
  "- GENDER ACCURACY (critical): every bible character is written with their name AND their exact gender using an " +
  "explicit gendered noun. Never swap or reverse a character's gender. For side characters, pick one gender from the " +
  "script context and state it explicitly, and keep it identical everywhere in the story.\n" +
  "- AGE ACCURACY (critical): every bible character has a fixed age — copy it into every prompt they appear in " +
  "('a 45-year-old man', 'an elderly woman with deep wrinkles', 'a 7-year-old child'). A character must look the " +
  "SAME age in every panel: a child is never drawn adult, an old person is never drawn young, a teenager is never " +
  "drawn middle-aged. Add the visible age markers the bible implies (wrinkles and grey hair for the elderly, small " +
  "childlike stature and round face for a child). For unnamed side characters, state one explicit age and keep it " +
  "consistent for the whole story.\n" +
  "- TWO OR MORE PEOPLE IN FRAME (critical): name each person separately with their gender, their own EXACT age and " +
  "their own distinct traits, and say where each one stands. Never write 'two figures' or 'the two of them', and " +
  "never let one character's hair, clothing, age or body type bleed onto the other.\n" +
  "- MIXED PAIRS (critical): when two people in one frame differ in age or gender, write the CONTRAST explicitly " +
  "next to both of them — 'Ravi, a clearly MALE elderly man with deep wrinkles and white hair, beside Meena, a " +
  "clearly FEMALE 8-year-old girl, small and round-faced'. Never make a young character look the same age as the " +
  "older one beside them, never age a child up or an elder down to match the other person, and never draw a male " +
  "character feminine (or a female one masculine) just because they share the frame with the opposite gender.\n" +
  "- HEAD COUNT: state explicitly how many people are in frame and that nobody else is present.\n" +
  "- FIGHTING & MAGIC (critical): these stories are action fantasy. Whenever the line contains combat, a technique, a " +
  "spell, an awakening, a transformation, a curse, an aura, a summon, a beast, a weapon clash or any supernatural " +
  "ability, the prompt MUST describe it as visible drawable energy and motion: the exact stance and mid-motion body " +
  "mechanics of every fighter (which foot forward, which arm extended, where the fist/blade/palm is), the precise " +
  "shape, colour and direction of the power (for example 'jagged violet lightning spiralling up his right forearm and " +
  "bursting forward in a cone'), the point of impact, and the physical consequence in the environment (cracked ground, " +
  "shattered stone, torn cloth, dust ring, splintered trees, displaced air, scattered debris, blood, sweat, cuts). " +
  "State the eyes glowing or not, the aura around each body, the speed lines implied by the pose, and where each " +
  "fighter's gaze is locked. Copy each character's own established ability, weapon and power colour from the bible and " +
  "the earlier script lines so the same ability always looks the same; never give a character a power the script did " +
  "not give them. Also describe the battlefield itself in full — terrain, weather, sky, surrounding structures, " +
  "onlookers if the line has them — so the fight reads as happening in a real place at that exact timestamp.\n" +
  "- MAGICAL WORLD SETTINGS (critical): this story takes place in a magical fantasy world, so EVERY environment — a " +
  "classroom, school, training ground, forest, field, road, village, town, city, house, temple, market or arena — " +
  "must be described as a place inside that magical world, never as a plain modern everyday location. Give each " +
  "setting 2-3 concrete magical-world features the script does not forbid: floating lanterns or drifting arcane " +
  "sigils, glowing runes and enchanted objects, crystalline or otherworldly plants, fantasy architecture such as " +
  "arched stonework, towering spires or carved totems, light motes in the air, an unusual sky (twin moons, " +
  "aurora-tinted clouds, distant floating islands). Keep the script's location type and era recognisable — a " +
  "classroom stays a classroom, a village stays a village — but they are the classroom and village of a magical " +
  "world, with those fantasy features drawn in foreground, midground and background.\n" +
  "- Exactly one scene, one moment, one instance of each character. Never ask for multiple panels, insets or collages.\n" +
  "- NO-CHARACTER LINES (critical): if the line describes only a place, an object, the sky, weather or a phenomenon and " +
  "involves no person, the prompt MUST be a pure environment shot with NOBODY in it. Start it with 'Empty environment " +
  "shot, no people:'. Never add a silhouette, an onlooker or a main character just to fill the frame.\n" +
  "- CROWD LINES: if the line says many people, everyone, a crowd, an army, soldiers or people running, show that " +
  "crowd or force, made of unnamed people who are not the main cast.\n" +
  "- NO TEXT: never describe text, letters, words, numbers, signs, posters, banners, newspapers, book pages, screens " +
  "with writing, labels or logos. Show the OBJECT and the reaction instead, never the writing.\n" +
  "- SHORT / NEARLY EMPTY LINES (critical): some lines are very short — a shout, a name, one word, a reaction, or a " +
  "silent beat with almost no words. Such a line has NO new setting of its own, so you MUST hold the SAME place, the " +
  "SAME people and the SAME time of day as the surrounding lines, and only change the camera (a closer angle, a " +
  "reaction close-up, a detail of the same scene) or the person's expression. NEVER invent a new location, new " +
  "characters, a new era or an unrelated event for a short line, and never jump to a scene the script does not have. " +
  "When such a line is marked with CONTEXT below, take its place and people from that context verbatim.\n" +
  "- 42 to 58 words each — put the exact visible action, named cast and place in the FIRST sentence. Keep every word visual and load-bearing. English only. The image engine gives the beginning much more weight, so never open with mood, history or explanation.\n" +
  "OUTPUT FORMAT (strict about the shape, nothing else): one plain line per requested script line, each starting with " +
  "that script line's own number, then ') ', then the whole prompt on that same single line. Example:\n" +
  "37) In the sunlit courtyard, Henan, a male 17-year-old boy ...\n38) Close-up of ...\n" +
  "No JSON, no quotes, no brackets, no bullets, no headings, no blank lines, and never break one prompt across lines.";

/** Hard ceiling for one published text request; larger payloads can sit idle at the edge. */
const MAX_SCRIPT_CHARS = 72_000;
const BIBLE_INPUT_CHARS = 48_000;

/** Samples opening, middle and ending without cutting the request at only the opening. */
function representativeScript(script: string, limit: number): string {
  if (script.length <= limit) return script;
  const slices = 4;
  const width = Math.floor(limit / slices);
  const maxStart = script.length - width;
  return Array.from({ length: slices }, (_, i) => {
    const start = Math.floor((maxStart * i) / (slices - 1));
    return `[SCRIPT EXCERPT ${i + 1}/${slices}]\n${script.slice(start, start + width)}`;
  }).join("\n\n…\n\n");
}

/**
 * How much of the script is pasted in for continuity on one prompt-writing
 * request. A full two-hour script is hundreds of thousands of characters; on a
 * long story that made every single request enormous and slow, which is why
 * long scripts finished with no prompts at all. Below this size the whole
 * script still goes in; above it, the request carries the story opening plus a
 * generous window around the lines being drawn.
 */
const CONTEXT_CHARS = 28_000;
/** Lines of story kept before/after the batch when the script is long. */
const CONTEXT_BEFORE = 120;
const CONTEXT_AFTER = 60;

/** Numbers the WHOLE script, 1-based, exactly as the model must answer it. */
function numberScript(all: Segment[]): string {
  return all.map((s, i) => `${i + 1}. [${s.start}s-${s.end}s] ${s.text}`).join("\n");
}

/**
 * True for a line with almost nothing drawable in it: a very short shout, a
 * name, a reaction, or a silent beat. These are the lines that used to come
 * back as a completely unrelated scene, because the model had nothing to work
 * from and invented one.
 */
export function isShortLine(text: string): boolean {
  const t = text.trim();
  if (/^continuation of the same moment/i.test(t)) return true;
  const words = t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.length < 6 || t.length < 28;
}

/** Nearest substantial neighbour line (previous first, then next) for anchoring. */
function nearestSubstantialLine(all: Segment[], n: number): string | null {
  for (let i = n - 2; i >= 0 && i >= n - 8; i--) {
    const t = all[i]?.text?.trim();
    if (t && !isShortLine(t)) return t.slice(0, 400);
  }
  for (let i = n; i < all.length && i < n + 6; i++) {
    const t = all[i]?.text?.trim();
    if (t && !isShortLine(t)) return t.slice(0, 400);
  }
  return null;
}


function numberRange(all: Segment[], from: number, to: number): string {
  return all
    .slice(from - 1, to)
    .map((s, i) => `${from + i}. [${s.start}s-${s.end}s] ${s.text}`)
    .join("\n");
}

/** Story context for one batch: the whole script when short, a window when long. */
function contextFor(all: Segment[], full: string, want: number[]): string {
  if (full.length <= CONTEXT_CHARS) return full;
  const first = Math.max(1, (want[0] as number) - CONTEXT_BEFORE);
  const last = Math.min(all.length, (want[want.length - 1] as number) + CONTEXT_AFTER);
  const opening = numberRange(all, 1, Math.min(30, all.length));
  const windowed = numberRange(all, first, last);
  return first > 31
    ? `STORY OPENING:\n${opening}\n\n...\n\nSTORY AROUND THESE LINES:\n${windowed}`
    : windowed;
}

/**
 * Writes image prompts for lines `from`..`to` (1-based, inclusive).
 *
 * Prompts are written in batches (the caller decides the batch size) because a
 * single answer covering an entire long script never completes: the answer, not
 * the input, is what has a ceiling. Each request carries the character bible
 * plus as much surrounding story as fits, so continuity is kept, and only
 * genuinely missing lines are asked for again.
 */
export async function writePrompts(
  bible: string,
  all: Segment[],
  from: number,
  to: number,
  requested?: number[],
): Promise<string[]> {
  bible = normalizeLeadCharacter(bible);
  const wanted = requested?.length
    ? [...new Set(requested)].filter((n) => n >= from && n <= to).sort((a, b) => a - b)
    : Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const count = wanted.length;
  if (count <= 0) return [];

  const full = numberScript(all);

  const ask = async (want: number[], temp: number) => {
    const first = want[0] as number;
    const last = want[want.length - 1] as number;
    const contiguous = want.length === last - first + 1;
    const script = contextFor(all, full, want);
    const listing = want
      .map((n) => {
        const s = all[n - 1] as Segment;
        const base = `${n}. [${s.start}s-${s.end}s] ${s.text}`;
        const before = all[n - 2]?.text?.trim();
        const after = all[n]?.text?.trim();
        const neighbours = [
          before ? `PREVIOUS: ${before.slice(0, 500)}` : "",
          after ? `NEXT: ${after.slice(0, 500)}` : "",
        ].filter(Boolean);
        const shortAnchor = isShortLine(s.text) ? nearestSubstantialLine(all, n) : null;
        return [
          base,
          neighbours.length
            ? `   CONTINUITY CONTEXT (resolve place, cast and pronouns; do not draw this context's action): ${neighbours.join(" | ")}`
            : "",
          shortAnchor
            ? `   SHORT-LINE ANCHOR (hold this scene and change only action/expression/camera): ${shortAnchor}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n");


    return textChat(
      PROMPT_SYSTEM,
      `CHARACTER BIBLE:\n${bible || "(none)"}\n\n` +
        `NUMBERED SCRIPT (read it for continuity):\n${script}\n\n` +
        `LINES TO DRAW — write ONE prompt for EACH of these ${want.length} lines and nothing else. ` +
        `Each prompt draws ONLY its own numbered line's moment, place and action, and must be ` +
        `recognisable as that line:\n${listing}\n\n` +
        `Output exactly ${want.length} lines, numbered with each line's OWN number` +
        `${contiguous ? ` (${first} to ${last})` : ` (${want.join(", ")})`}, then ') ', ` +
        `then that same line's OWN start time copied exactly from the list above in square ` +
        `brackets (for example "12) [86s] ..."), then the prompt, all on that same single line. ` +
        `The number and the start time must both belong to the line the prompt draws. Nothing else.`,
      {
        temperature: temp,
        // One-prompt requests get a generous budget so a single timestamp can be
        // described with full fight/magic/environment detail.
        maxOutputTokens:
          want.length === 1 ? 2_000 : Math.min(32_000, 700 + want.length * 160),
        timeoutMs: 3_600_000,
        attempts: 6,
      },
    );
  };


  const byNumber = new Map<number, string>();

  const absorb = (raw: string, want: number[]) => {
    // Answers are numbered with the GLOBAL line number, so the parser is fed
    // the highest expected number and the results re-keyed.
    const parsed = parseNumberedList(raw, all.length);
    const entries: { n: number; text: string }[] = [];
    parsed.forEach((v, idx) => {
      if (typeof v === "string" && v.trim().length > 30)
        entries.push({ n: idx + 1, text: v.trim() });
    });
    if (entries.length === 0) return;

    // Timestamp fidelity gate: accept a prompt only when it shares a content
    // word with its OWN script line (checked for English lines; Hindi lines
    // cannot be word-matched, so they are checked later, per line, by the
    // scene checker just before rendering).
    const accept = (n: number, text: string) => {
      const seg = all[n - 1];
      if (seg && isEnglishish(seg.text) && !mentionsLine(text, seg.text)) return;
      byNumber.set(n, text);
    };

    const wantSet = new Set(want);
    const first = want[0] as number;
    const last = want[want.length - 1] as number;

    // TIMESTAMP ECHO (authoritative). Each prompt repeats its own line's start
    // time. When every prompt carries one and they map cleanly onto distinct
    // requested lines, that mapping wins over the answer's numbering — this is
    // what stops a whole range sliding one line late.
    const echoed: { n: number; text: string }[] = [];
    let echoes = 0;
    for (const e of entries) {
      const m = /^\[\s*(\d+(?:\.\d+)?)\s*s?\s*\]\s*/.exec(e.text);
      if (!m) {
        echoed.push(e);
        continue;
      }
      echoes++;
      const at = Number(m[1]);
      const body = e.text.slice(m[0].length).trim();
      const hit = want.find((n) => Math.abs(((all[n - 1] as Segment).start ?? -1) - at) < 0.5);
      echoed.push({ n: hit ?? e.n, text: body });
    }
    if (echoes === entries.length && echoes > 0) {
      const keys = echoed.map((e) => e.n);
      const unique = new Set(keys).size === keys.length;
      if (unique && keys.every((n) => wantSet.has(n))) {
        for (const e of echoed) accept(e.n, e.text);
        return;
      }
    }
    // No usable echo: fall back to the numbering rules below, with any echo
    // prefix stripped so it never leaks into the image prompt.
    entries.splice(0, entries.length, ...echoed);

    // TIMESTAMP ALIGNMENT (this is what used to shift panels onto the wrong
    // moment). Two numbering styles come back:
    //   global    — the answer uses this script's own line numbers
    //   renumbered— the answer restarts at 1) regardless of what was asked
    // The old code trusted ANY number that happened to fall inside the
    // requested range. When a range started low enough (say lines 30-89) a
    // renumbered answer's "30)" — really the 30th prompt of the range, i.e.
    // script line 59 — was accepted as line 30, so every panel in that range
    // drew a scene from ~29 lines later in the script. Decide the style ONCE,
    // from the whole answer, and never mix the two.
    const lowest = entries.reduce((m, e) => Math.min(m, e.n), entries[0]!.n);
    const highest = entries.reduce((m, e) => Math.max(m, e.n), entries[0]!.n);
    const ascending = entries.every((e, i) => i === 0 || e.n > entries[i - 1]!.n);
    const looksGlobal = lowest >= first && highest <= last;

    if (looksGlobal) {
      // Every number in the answer belongs to this request: trust them.
      for (const e of entries) if (wantSet.has(e.n)) accept(e.n, e.text);
      return;
    }

    // Renumbered: the answer restarts at 1. Map by the answer's own number
    // (1 -> want[0], 2 -> want[1], ...) — safe even when the answer is
    // truncated or skips a number, because each prompt still carries its own
    // position in the requested list.
    if (ascending && lowest === 1 && highest <= want.length) {
      for (const e of entries) accept(want[e.n - 1] as number, e.text);
      return;
    }

    // Unnumbered / oddly numbered but exactly the right amount, in order:
    // positional mapping is unambiguous.
    if (ascending && entries.length === want.length) {
      entries.forEach((e, i) => accept(want[i] as number, e.text));
      return;
    }

    // Anything else: keep only the numbers that clearly belong to this request
    // instead of throwing the whole answer away (which stalled long runs).
    let kept = 0;
    for (const e of entries) {
      if (wantSet.has(e.n)) {
        accept(e.n, e.text);
        kept++;
      }
    }
    if (kept === 0) {
      console.error(
        `writePrompts: answer numbering does not match request ` +
          `(${entries.length} prompts numbered ${lowest}-${highest} for lines ${first}-${last}) — discarded`,
      );
    }

  };

  // One compact request for the range. The browser deliberately keeps ranges
  // small so the writer can give every timestamp enough attention.
  const t0 = Date.now();
  console.log(`[prompts] START lines ${from}-${to} (${count} lines)`);
  let mainError: unknown;
  try {
    const raw = await ask(wanted, 0.7);
    console.log(
      `[prompts] main answer for ${from}-${to}: ${raw.length} chars in ${Date.now() - t0}ms`,
    );
    absorb(raw, wanted);
    console.log(`[prompts] after main pass ${from}-${to}: ${byNumber.size}/${count} filled`);
  } catch (e) {
    if (e instanceof KilledError) throw e;
    mainError = e;
    console.error(
      `[prompts] main pass FAILED ${from}-${to} after ${Date.now() - t0}ms:`,
      e instanceof Error ? e.message : e,
    );
  }


  /**
   * Timestamp fidelity, applied BEFORE the repair pass.
   *
   * A prompt that shares no content word with its OWN line was written from
   * some other part of the script. These used to be discarded only at the very
   * end, after the repair pass had already run, so the line came back empty and
   * the panel failed. Dropping them here folds them into the same repair
   * request as truncated gaps.
   */
  const dropUnfaithful = () => {
    for (const n of wanted) {
      const own = byNumber.get(n);
      if (!own) continue;
      const seg = all[n - 1] as Segment;
      if (isEnglishish(seg.text) && !mentionsLine(own, seg.text)) byNumber.delete(n);
    }
  };
  dropUnfaithful();

  // Repair what is missing (a truncated answer or a rejected prompt) in as few
  // extra requests as possible: one request for all the gaps together, and a
  // second round for anything still unusable.
  for (let round = 0; round < 2; round++) {
    const gap = wanted.filter((n) => !byNumber.has(n));
    if (gap.length === 0) break;
    const t1 = Date.now();
    console.log(`[prompts] repair pass ${round + 1} for ${gap.length} gaps in ${from}-${to}`);
    try {
      absorb(await ask(gap, 0.5 + round * 0.2), gap);
      dropUnfaithful();
      mainError = undefined;
      console.log(
        `[prompts] after repair ${round + 1} ${from}-${to}: ${byNumber.size}/${count} filled in ${Date.now() - t1}ms`,
      );
    } catch (e) {
      if (e instanceof KilledError) throw e;
      mainError = e;
      console.error(
        `[prompts] repair FAILED ${from}-${to} after ${Date.now() - t1}ms:`,
        e instanceof Error ? e.message : e,
      );
      break;
    }
  }

  // The whole range came back empty because the writing service itself failed
  // (bad/missing key, outage, rate limit). Report that instead of returning a
  // range of blanks: silently blank prompts made every panel show "failed" with
  // no reason, and pushed the browser into its slow one-line-at-a-time repair.
  if (byNumber.size === 0) {
    const why = mainError instanceof Error ? mainError.message : String(mainError ?? "no prompts");
    throw new Error(`Prompt writer unavailable for lines ${from}-${to}: ${why}`);
  }


  // Duplicate diagnostic only. Prompts commonly share a long style/character
  // prefix while describing different actions later in the text. The previous
  // guard compared only the first 160 characters and deleted those valid
  // timestamp-mapped prompts after the repair pass, leaving panels with no
  // prompt and therefore no image. Timestamp echoes/numbering above are the
  // authoritative mapping; never erase a mapped prompt here.
  const seen = new Map<string, number>();
  for (const n of wanted) {
    const own = byNumber.get(n);
    if (!own) continue;
    const fingerprint = own.trim().toLowerCase().replace(/\s+/g, " ");
    const first = seen.get(fingerprint);
    if (first !== undefined && first !== n) {
      console.warn(`writePrompts: lines ${first} and ${n} returned identical prompts; keeping both timestamp slots`);
    } else {
      seen.set(fingerprint, n);
    }
  }

  // ONE ENTRY PER REQUESTED LINE, ALWAYS. The array is positional: the caller
  // maps built[i] onto line (from + i), so a missing prompt must stay in place
  // as an empty string. Throwing (the old behaviour) killed the prompts of the
  // whole range because of one unusable line, which is why some timestamps
  // ended up with no prompt of their own at all.
  const built: string[] = [];
  for (const n of wanted) {
    const seg = all[n - 1] as Segment;
    const own = byNumber.get(n);
    // Timestamp fidelity: a prompt that shares no content word with its OWN
    // line was written from some other part of the script. Reject it so the
    // per-line repair below replaces it instead of drawing the wrong moment.
    if (own && isEnglishish(seg.text) && !mentionsLine(own, seg.text)) {
      byNumber.delete(n);
    } else if (own) {
      built.push(sanitizePrompt(enforceTimestampCast(own, all, n, bible)));
      continue;
    }

    // Never silently turn a failed Hindi/Hinglish interpretation into a generic
    // nearby scene. An empty slot is safer: the browser's repair pass asks the
    // writer again with a much smaller neighbourhood. Generic fallback prompts
    // were the direct cause of plausible-looking but incorrect panels.
    console.warn(`writePrompts: line ${n} needs a focused repair`);
    built.push("");

  }

  const empties = built.filter((p) => !p.trim()).length;
  console.log(
    `[prompts] DONE lines ${from}-${to} in ${Date.now() - t0}ms: ${built.length - empties}/${count} written, ${empties} empty`,
  );
  return chainContinuity(built, all, wanted);
}


/** Locations the image engine can actually stage, as written in prompts. */
const SETTING_WORDS: string[] = [
  "bedroom",
  "kitchen",
  "bathroom",
  "living room",
  "drawing room",
  "hallway",
  "corridor",
  "staircase",
  "rooftop",
  "terrace",
  "balcony",
  "courtyard",
  "veranda",
  "room",
  "house",
  "home",
  "hut",
  "mansion",
  "haveli",
  "temple",
  "shrine",
  "church",
  "mosque",
  "school",
  "classroom",
  "college",
  "office",
  "hospital",
  "clinic",
  "police station",
  "prison",
  "cell",
  "shop",
  "market",
  "bazaar",
  "restaurant",
  "cafe",
  "hotel",
  "street",
  "road",
  "alley",
  "village",
  "town",
  "city",
  "railway station",
  "bus stop",
  "airport",
  "train",
  "bus",
  "car",
  "jungle",
  "forest",
  "woods",
  "field",
  "farm",
  "garden",
  "park",
  "mountain",
  "valley",
  "hill",
  "cave",
  "desert",
  "river",
  "riverbank",
  "lake",
  "beach",
  "sea",
  "boat",
  "graveyard",
  "cremation ground",
  "ruins",
  "factory",
  "warehouse",
  "workshop",
  "well",
];

/** The first staged location named in a written prompt, or null. */
function detectSetting(prompt: string): string | null {
  const p = prompt.toLowerCase();
  let best: { word: string; at: number } | null = null;
  for (const word of SETTING_WORDS) {
    const at = p.indexOf(word);
    if (at === -1) continue;
    if (!best || at < best.at || (at === best.at && word.length > best.word.length)) {
      best = { word, at };
    }
  }
  return best ? best.word : null;
}

/** Hindi / romanised place words that mark a genuine change of location. */
const PLACE_CUES: RegExp = new RegExp(
  [
    "घर", "कमरे?", "कमरा", "रसोई", "आँगन|आंगन", "छत", "बरामदा", "जंगल", "सड़क", "गली",
    "बाज़ार|बाजार", "दुकान", "स्कूल", "कॉलेज", "दफ़्तर|दफ्तर", "अस्पताल", "थाना", "जेल",
    "मंदिर", "मस्जिद", "गिरजा", "गाँव|गांव", "शहर", "खेत", "बग़ीचा|बगीचा", "पहाड़", "नदी",
    "तालाब", "समुंदर|समुद्र", "गुफ़ा|गुफा", "श्मशान", "कुआँ|कुआं", "स्टेशन", "ट्रेन", "बस",
    "गाड़ी", "कार", "होटल", "छत पर",
    "ghar", "kamra", "kamre", "rasoi", "aangan", "chhat", "jungle", "sadak", "gali",
    "bazaar", "dukan", "school", "college", "office", "hospital", "thana", "jail",
    "mandir", "masjid", "gaon", "gaanv", "shehar", "khet", "bagicha", "pahad", "nadi",
    "talab", "samundar", "gufa", "shamshan", "kuan", "station", "train", "bus",
    "gaadi", "car", "hotel",
  ].join("|"),
  "i",
);

/**
 * Panel-to-panel setting continuity.
 *
 * The writing model often re-imagines the backdrop for narration lines that do
 * not restate where the scene is, which made consecutive panels jump house →
 * jungle → house. A panel may only move to a new location when its OWN script
 * line names a place (or the prompt is the first of the run). Otherwise the
 * established location is restated in the prompt so the picture stays in it.
 */
export function chainContinuity(
  prompts: string[],
  all?: Segment[],
  wanted?: number[],
): string[] {
  if (!all || !wanted || wanted.length !== prompts.length) return prompts;
  let active: string | null = null;
  return prompts.map((prompt, i) => {
    if (!prompt.trim()) return prompt;
    const here = detectSetting(prompt);
    if (here) {
      // The writer named a place for THIS timestamp. That place is the script's
      // own, so it is never overwritten with an earlier panel's location — the
      // old rewrite silently moved whole stretches of the story into the first
      // panel's room whenever the Hindi line's place word was not in the cue
      // list, which made prompts read as a different scene than the script.
      active = here;
      return prompt;
    }
    if (!active) return prompt;
    // Only a prompt with NO place of its own inherits the running location, and
    // it is described as scenery, never as an instruction.
    return `${prompt}. The same ${active} as the previous panel, with the same walls, furniture, props and time of day`;
  });
}



/** True when a string is mostly Latin-script text the image engine can read. */
export function isEnglishish(s: string): boolean {
  const letters = s.replace(/[^\p{L}]/gu, "");
  if (!letters) return false;
  const latin = letters.replace(/[^A-Za-z]/g, "").length;
  return latin / letters.length >= 0.85;
}

/**
 * True when a written image prompt shares at least one meaningful word with
 * the script line it belongs to. A prompt that shares nothing was almost
 * certainly written from a different timestamp, so the caller rejects it.
 */
export function mentionsLine(prompt: string, line: string): boolean {
  const stop = new Set([
    "this",
    "that",
    "with",
    "from",
    "then",
    "than",
    "they",
    "them",
    "their",
    "there",
    "here",
    "when",
    "what",
    "into",
    "over",
    "under",
    "about",
    "have",
    "has",
    "had",
    "were",
    "was",
    "are",
    "and",
    "the",
    "his",
    "her",
    "him",
    "she",
    "but",
    "not",
  ]);
  const words = line
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !stop.has(w));
  if (words.length === 0) return true;
  const p = prompt.toLowerCase();
  return words.some((w) => p.includes(w));
}

function fallbackPrompt(s: Segment, action?: string): string {
  const moment = action ? action : s.text;
  // A non-English line still MUST get a timestamp-specific prompt. This branch
  // is enriched with an adjacent written prompt by guaranteedPrompt below.
  if (!isEnglishish(moment)) {
    return (
      "Continue the established scene at this exact next story beat, retaining the same location, " +
      "time of day, room layout and active characters; advance their visible action, pose and expression, " +
      "with a different camera angle and no text anywhere in frame"
    );
  }
  return (
    "A single detailed scene in clear natural lighting, with a fully drawn background, " +
    `depicting this exact story moment: ${moment}`
  );
}

/**
 * Guaranteed prompt for a line the model would not write.
 *
 * Borrows the nearest English line around it so the picture still belongs to
 * this part of the story, then falls back to a neutral scene. Never empty.
 */
function guaranteedPrompt(
  all: Segment[],
  n: number,
  bible: string,
  written: Map<number, string>,
): string {
  const self = all[n - 1] as Segment;
  if (isEnglishish(self.text)) return fallbackPrompt(self);
  const named = namedBibleEntries(self.text, bible);
  const cast = named.length
    ? ` The current line explicitly includes ${named.map((e) => `${e.name}: ${e.traits}`).join("; ")}. Show them in frame.`
    : "";
  for (let d = 1; d <= 6; d++) {
    for (const neighbour of [n - d, n + d]) {
      const existing = written.get(neighbour);
      if (existing) {
        return (
          `Continue the established story scene from this nearby timestamp: ${clip(existing, 520)}. ` +
          `This is timestamp ${n}, a distinct next beat: preserve the location, time, set details and continuing cast, ` +
          `but advance the visible action, pose, expression and camera composition.${cast}`
        );
      }
    }
  }
  for (let d = 1; d <= 6; d++) {
    for (const i of [n - 1 - d, n - 1 + d]) {
      const near = all[i];
      if (near && isEnglishish(near.text)) {
        return (
          "A single detailed scene in clear natural lighting, with a fully drawn background " +
          `and no text in frame, set in the same place and moment as: ${near.text}`
        );
      }
    }
  }
  return fallbackPrompt(self);
}


/** Phrases that make Flux draw letterforms. Replaced with a neutral equivalent. */
const TEXT_TRIGGERS: [RegExp, string][] = [
  [
    /\b(sign(board|age)?s?|street sign|shop sign)\b\s*(that\s+)?(reads?|saying|says)?[^,.]*/gi,
    "weathered wall",
  ],
  [
    /\b(poster|posters|billboard|billboards|banner|banners|placard|flyer|leaflet|brochure)\b/gi,
    "bare wall",
  ],
  // Paper props only when they are the object itself. A trailing noun means the
  // word is an adjective for real furniture ("ticket machine", "note board"),
  // which must be left intact — rewriting it produced nonsense like
  // "a small worn paper object machine on the wall".
  [
    /\b(newspaper|newspapers|magazine|magazines|letter|letters|envelope|note|notes|notebook|diary|book page|pages of a book|document|documents|contract|receipt|ticket|label|labels|tag|tags)\b(?!\s+(machine|machines|counter|booth|stand|window|holder|dispenser|rack|box|board|shelf|kiosk|gate|barrier|office|hall|desk))/gi,
    "worn paper object",
  ],
  [
    /\b(text|texts|writing|written words?|words?\s+written|caption|captions|subtitle|subtitles|title card|handwriting|calligraphy|graffiti|inscription|slogan|logo|logos|brand name|watermark|number plate|license plate|numberplate)\b/gi,
    "",
  ],
  [/\b(that|which)\s+(reads?|says?)\b[^,.]*/gi, ""],
  [/\breading\s+(a|an|the)\s+\w+/gi, "holding an object"],
  [
    /\b(screen|display|monitor|phone screen|laptop screen)\s+(showing|displaying|with)\b[^,.]*/gi,
    "dark glowing screen",
  ],
  // Balloons/lettering furniture: naming them at all makes Flux draw them.
  [/\b(speech|thought|dialogue|word)\s*(bubble|balloon)s?\b/gi, ""],
  [
    /\b(comic|manga|manhwa|webtoon)\s+(page|panel|panels|strip|layout|gutters?)\b/gi,
    "illustration",
  ],
  [
    /\b(says?|saying|said|speaks?|speaking|spoke|tells?|telling|replies|replied|answers?|answered|adds?|added|asks?|asking|states?|declares?|continues?|shouts?|shouting|whispers?|whispering|yells?|screams?|mutters?|exclaims?)\b[^"“]{0,40}["“][^"”]{0,400}(?:["”']|$)/gi,
    "",
  ],
  [/"[^"]{0,400}"/g, ""],
  // An unterminated quote (the writer's sentence was cut mid-speech) used to
  // survive every rule and reached the renderer as lettering.
  [/["“][^"”]{0,400}$/g, ""],
  // Single quotes: ONLY a genuine quoted span. The old /'[^']{2,120}'/ treated
  // two possessive apostrophes as a pair and deleted everything between them —
  // "Henan's ... demon's" lost the whole middle of the description. An opening
  // quote may not follow a letter, and a closing quote may not sit between
  // letters (that is a possessive or a contraction, not a quote).
  [/(?<![A-Za-z0-9])'(?=\S)[^'\n]{2,120}(?<=\S)'(?![A-Za-z0-9])/g, ""],
  [/“[^”]{0,120}”/g, ""],
];

/**
 * Metaphor scrubber. "his lungs burned with fire" was rendered LITERALLY —
 * flames erupting from a character's chest. Figurative body/soul imagery is
 * rewritten into the visible human reaction instead.
 */
const METAPHOR_TRIGGERS: [RegExp, string][] = [
  [
    /\b(lungs?|chest|throat|veins?|blood|body|skin|heart|soul|mind|nerves?)\s+(burning|on fire|aflame|ablaze|engulfed in flames?|filled with fire|searing with fire)\b/gi,
    "face contorted in pain, hand clutching the chest",
  ],
  [
    /\b(fire|flames?|embers?|lightning|electricity|energy)\s+(erupting|bursting|pouring|radiating|spreading)\s+(from|out of|through)\s+(his|her|their|the)\s+(chest|body|lungs?|throat|skin|veins?|mouth|eyes)\b/gi,
    "body tensed, breath sharp, expression strained",
  ],
  [
    /\b(glowing|luminous|visible|exposed|raw|pulsing)\s+(organs?|flesh|muscle|lungs?|veins?|anatomy|innards?)\b/gi,
    "strained expression",
  ],
  [
    /\b(soul|spirit|consciousness|essence)\s+(torn|ripped|wrenched|extracted|pulled|dragged)\s+\w*\s*(from|out of)[^,.]*/gi,
    "whole body convulsing, eyes wide with shock",
  ],
  [
    /\b(x-?ray|anatomical cutaway|see-through body|transparent body|internal organs? view)\b/gi,
    "normal opaque body",
  ],
  [
    /\b(surreal|symbolic|abstract|metaphorical|dreamlike|otherworldly)\s+(imagery|vision|representation|overlay|effect)s?\b/gi,
    "grounded realistic depiction",
  ],
];

/**
 * Dark-tone scrubber. The storyboard has no mood filter any more, so any
 * leftover "dim / gloomy / mysterious" phrasing the text model still slips in
 * is rewritten into neutral, well-lit wording. Genuine script facts (night,
 * rain, a candle) are left alone — only the atmosphere adjectives go.
 */
const DARK_TRIGGERS: [RegExp, string][] = [
  [
    /\b(moody|gloomy|murky|ominous|foreboding|eerie|sinister|brooding|noir|mysterious|shadowy|dimly[- ]lit|dim|low[- ]key|chiaroscuro|oppressive|bleak|desaturated|muted)\s+(lighting|light|atmosphere|mood|tone|palette|colou?rs?|shadows?|room|scene|interior|street|corridor)\b/gi,
    "clear well-lit $2",
  ],
  [
    /\b(thick|deep|heavy|pitch|near|total|enveloping|swallowing)\s+(darkness|shadow|shadows|gloom|black)\b/gi,
    "soft natural light",
  ],
  [
    /\b(in|into|through|from|within|amid)\s+(the\s+)?(darkness|gloom|shadows|murk)\b/gi,
    "$1 the light",
  ],
  [/\b(hard|harsh|deep|long|heavy|dramatic)\s+shadows?\b/gi, "soft shadows"],
  [
    /\b(moody|gloomy|murky|ominous|foreboding|eerie|sinister|brooding|noir|mysterious|shadowy|dimly[- ]lit|low[- ]key|oppressive|bleak)\b,?\s*/gi,
    "",
  ],
  [/\b(dark|dim)\s+(and|,)\s+(mysterious|moody|gloomy|eerie)\b/gi, "clearly lit"],
];

/**
 * Art-style scrubber.
 *
 * The written prompt must describe CONTENT ONLY. Any medium/style/genre word
 * the writing model slips in (realistic, photo, 3D render, oil painting, and
 * even "anime"/"manga" themselves) is deleted here, so the ONLY style
 * statement that ever reaches the renderer is the fixed anime block added in
 * composeImagePrompt.
 */
const STYLE_TRIGGERS: [RegExp, string][] = [
  // "in the style of X", "X style", "rendered in X", "X art"
  [/\b(?:drawn|rendered|painted|illustrated|shot|captured)\s+(?:in|as|with)\s+[^,.]{0,60}/gi, ""],
  [/\bin\s+(?:the\s+)?style\s+of\s+[^,.]{0,60}/gi, ""],
  [/\b[\w-]+\s+(?:art\s+)?style\b/gi, ""],
  [
    /\b(photo[- ]?realistic|photorealism|photorealistic|hyper[- ]?realistic|realistic|realism|lifelike|true[- ]to[- ]life|photograph(y|ic)?|photo|dslr|bokeh|35mm|50mm|film grain|cinematic still|movie still|render(ed|ing)?|3d|cgi|unreal engine|octane|blender|pixar|disney|claymation|stop[- ]motion|low[- ]poly|voxel|pixel art|vector art|flat design|isometric)\b/gi,
    "",
  ],
  [
    /\b(anime|manga|manhwa|manhua|webtoon|comic book|cartoon|chibi|ghibli|shonen|shoujo|seinen|cel[- ]shaded|cel shading|line ?art|ink(ed)? drawing|pencil sketch|sketch(y)?|charcoal|watercolou?r|oil painting|acrylic|gouache|pastel drawing|digital painting|matte painting|concept art|illustration style|storybook illustration|woodcut|engraving|impressionist|surrealist|abstract|noir film|graphic novel)\b/gi,
    "",
  ],
  [/\b(4k|8k|hdr|ultra[- ]detailed|highly detailed render|trending on artstation|artstation)\b/gi, ""],
  // Photographic camera/lens/skin cues drag Flux back to its default photo look.
  [
    /\b(shallow depth of field|depth of field|telephoto|wide[- ]angle lens|macro lens|studio lighting|softbox|golden hour photo|candid|documentary|editorial|portrait photo|headshot|skin pores|subsurface scattering|ray[- ]?traced|volumetric lighting|lens flare|chromatic aberration|motion blur|long exposure|real[- ]life|true colour photo)\b,?\s*/gi,
    "",
  ],
];

/** Removes phrasing that makes the model draw a sheet/portrait, text, or a dark mood grade. */
export function sanitizePrompt(p: string): string {
  let out = p
    .replace(
      /\b(character (sheet|reference|design|lineup|turnaround|bible)|reference sheet|model sheet|inset portrait|split panel|multiple panels|panel grid|collage|side-by-side|two panels|comic page layout|storyboard grid)\b/gi,
      "",
    )
    .replace(
      /\b(black[- ]and[- ]white|black ?& ?white|monochrome|monochromatic|gr[ae]yscale|sepia|screentone|halftone|ink wash only)\b/gi,
      "full colour",
    );
  for (const [re, to] of TEXT_TRIGGERS) out = out.replace(re, to);
  for (const [re, to] of METAPHOR_TRIGGERS) out = out.replace(re, to);
  for (const [re, to] of DARK_TRIGGERS) out = out.replace(re, to);
  for (const [re, to] of STYLE_TRIGGERS) out = out.replace(re, to);


  return out
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .replace(/(,\s*){2,}/g, ", ")
    .replace(/^[\s,.-]+/, "")
    .trim();
}

/** Splits the text-only consistency sheet into `Name -> fixed traits` entries. */
export function parseBible(bible: string): { name: string; traits: string }[] {
  return bible
    .split("\n")
    .map((l) => l.replace(/^[\s\-*•\d.)]+/, "").trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(":");
      if (i < 1) return null;
      const name = l.slice(0, i).trim();
      const traits = l.slice(i + 1).trim();
      if (!name || name.length > 40 || !traits) return null;
      if (/^(?:place|location|setting)\s*-/i.test(name)) return null;
      return { name, traits };
    })
    .filter((v): v is { name: string; traits: string } => v !== null)
    .slice(0, 12);
}

/** Characters explicitly named in script text or a written prompt. */
function namedBibleEntries(text: string, bible?: string): { name: string; traits: string }[] {
  if (!bible) return [];
  const folded = text.toLocaleLowerCase();
  return parseBible(bible).filter((entry) => folded.includes(entry.name.toLocaleLowerCase()));
}

/** True when a line continues a previously established person's action. */
function hasPersonReference(text: string): boolean {
  return /\b(he|she|him|her|his|hers|they|them|their)\b|(?:वह|वो|उसने|उसका|उसकी|उसके|उसे|उन्होंने|उनका|उनकी|उनके|वे|उस|अपने|अपनी|अपना)/iu.test(
    text,
  );
}

/**
 * Deterministic timestamp cast repair. It handles the common Hindi/Hinglish
 * pattern where a character is named once and subsequent timestamps use only a
 * pronoun. The nearest recently named sheet character is carried forward only
 * for a person-referencing line, preventing unrelated narration from inheriting
 * the cast.
 */
function enforceTimestampCast(
  prompt: string,
  all: Segment[],
  n: number,
  bible?: string,
): string {
  if (!bible) return prompt;
  const current = all[n - 1];
  if (!current) return prompt;
  let required = namedBibleEntries(current.text, bible);
  if (required.length === 0 && hasPersonReference(current.text)) {
    for (let i = n - 2; i >= 0 && i >= n - 10; i--) {
      required = namedBibleEntries(all[i]?.text ?? "", bible);
      if (required.length > 0) break;
    }
  }
  if (required.length === 0) return prompt;
  const p = prompt.toLocaleLowerCase();
  const absent = required.filter((entry) => !p.includes(entry.name.toLocaleLowerCase()));
  if (absent.length === 0) return prompt;
  return `${prompt}. Required continuing cast visibly in frame: ${absent
    .map((entry) => entry.name)
    .join(", ")}.`;
}

/**
 * A pasted character sheet is authoritative. If the current timestamp names a
 * character but the writing model omitted that name, require the character
 * after the scene action. Full traits are appended later by characterLock; they
 * must not displace the timestamp action from the image encoder's short window.
 */
function enforceLineCast(prompt: string, line?: string, bible?: string): string {
  if (!line || !bible) return prompt;
  const named = namedBibleEntries(line, bible);
  if (named.length === 0) return prompt;
  const absent = named.filter(
    (entry) => !prompt.toLocaleLowerCase().includes(entry.name.toLocaleLowerCase()),
  );
  if (absent.length === 0) return prompt;
  const cast = absent.map((entry) => entry.name).join(" and ");
  // Natural sentence, never a metadata label: a line such as "Required cast:
  // Yuki, Sora" reads like a character sheet to Flux and came back as a lineup
  // of figures on blank paper instead of a scene.
  return `${prompt} ${cast} ${absent.length > 1 ? "are" : "is"} also in the shot, taking part in the same action.`;
}

/** Reads an explicit gender out of a bible line's traits. */
export function genderOf(traits: string): "male" | "female" | null {
  const t = ` ${traits.toLowerCase()} `;
  const male = /\b(male|man|boy|father|dad|brother|son|uncle|husband|he|his)\b/.test(t);
  const female = /\b(female|woman|girl|mother|mom|sister|daughter|aunt|wife|she|her)\b/.test(t);
  if (male && !female) return "male";
  if (female && !male) return "female";
  // both matched: trust whichever token appears first
  const mi = t.search(/\b(male|man|boy)\b/);
  const fi = t.search(/\b(female|woman|girl)\b/);
  if (mi === -1 && fi === -1) return null;
  if (fi === -1) return "male";
  if (mi === -1) return "female";
  return mi < fi ? "male" : "female";
}

/**
 * Deterministic gender repair. The text model occasionally writes "she" for a
 * male character (or the reverse), and Flux then draws the wrong person. This
 * rewrites pronouns and gendered nouns in the prompt to match the bible, and
 * stamps an explicit gendered noun right after each character's name.
 */
export function enforceGender(prompt: string, bible?: string): string {
  if (!bible) return prompt;
  const entries = parseBible(bible).filter((e) => genderOf(e.traits));
  if (entries.length === 0) return prompt;

  const present = entries.filter((e) => new RegExp(`\\b${escapeRe(e.name)}\\b`, "i").test(prompt));
  if (present.length === 0) return prompt;

  let out = prompt;

  // Only rewrite pronouns when a single character is in frame — with two
  // characters we cannot tell which pronoun belongs to whom.
  if (present.length === 1) {
    const g = genderOf(present[0]!.traits)!;
    const map: Record<string, string> =
      g === "male"
        ? {
            she: "he",
            her: "his",
            hers: "his",
            herself: "himself",
            woman: "man",
            girl: "boy",
            lady: "man",
            "young woman": "young man",
          }
        : {
            he: "she",
            his: "her",
            him: "her",
            himself: "herself",
            man: "woman",
            boy: "girl",
            gentleman: "woman",
            "young man": "young woman",
          };
    for (const [from, to] of Object.entries(map)) {
      out = out.replace(new RegExp(`\\b${from}\\b`, "gi"), (m) =>
        m[0] === m[0]!.toUpperCase() ? to[0]!.toUpperCase() + to.slice(1) : to,
      );
    }
  }

  // Put one compact identity tag at the character's FIRST mention. Repeating
  // long identity instructions after every name made Flux focus on generic
  // portraits and ignore the timestamp's setting/action.
  for (const e of present) {
    const g = genderOf(e.traits)!;
    const noun = g === "male" ? "male" : "female";
    // Short label only ("23-year-old"). The full look description
    // ("visibly older, lined face, greying hair") made the tag read as
    // "a 60-year-old visibly older, lined face, greying hair man".
    const age = ageLabel(e.traits);
    const person = noun === "male" ? "man" : "woman";
    const tag = age ? `a ${age} ${person}` : `a ${person}`;
    out = out.replace(
      new RegExp(`\\b${escapeRe(e.name)}\\b(?!\\s*\\((male|female)\\b)`, "i"),
      `${e.name} (${tag})`,
    );
  }

  // No cast ledger. A trailing "Distinct cast: Yuki: male, 23; Mio: female, 16"
  // is sheet metadata: Flux answered it with a row of separated figures facing
  // the camera. Each person is already tagged inline at their first mention.
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Just the age words ("23-year-old", "elderly"), never the look sentence. */
export function ageLabel(traits: string): string {
  const num = /\b(\d{1,2})\s*(?:-|\s)?year[s]?[- ]old\b/.exec(traits.toLowerCase());
  if (num) return `${num[1]}-year-old`;
  const t = traits.toLowerCase();
  if (/\b(elderly|old|aged|grand(mother|father|ma|pa)|buzurg|budhi|budha)\b/.test(t)) return "elderly";
  if (/\b(middle[- ]aged|forties|fifties|40s|50s)\b/.test(t)) return "middle-aged";
  if (/\b(teen(age[rd]?)?|adolescent|schoolboy|schoolgirl)\b/.test(t)) return "teenage";
  if (/\b(child|kid|little (boy|girl)|toddler)\b/.test(t)) return "young";
  return "";
}

/**
 * One body per person. The writing model often repeats a character right after
 * their name — "Kai (a 19-year-old man), a 19-year-old young man with a short
 * black undercut, ..." — and Flux drew a separate figure for each mention, so
 * panels came back with twins. The repeated appositive is dropped; the traits
 * still reach the renderer once through the identity brief.
 */
export function collapseRepeatedIdentity(prompt: string, bible?: string): string {
  if (!bible) return prompt;
  let out = prompt;
  for (const entry of parseBible(bible)) {
    const name = escapeRe(entry.name);
    // Name (tag), <a/an ... man|woman|boy|girl ...>,  -> Name (tag),
    out = out.replace(
      new RegExp(
        `(\\b${name}\\b\\s*\\([^)]*\\))\\s*,\\s*(?:an?|the)\\s+[^.;]{0,180}?\\b(?:man|woman|boy|girl|male|female|person)\\b[^.;]{0,120}?(?=\\s*[,.;]|$)`,
        "gi",
      ),
      "$1",
    );
    // A bare second mention of the same identity phrasing right after the name.
    out = out.replace(
      new RegExp(`(\\b${name}\\b)\\s*,\\s*(?:an?|the)\\s+\\d{1,2}-year-old\\b[^.;]{0,150}?(?=\\s*[,.;]|$)`, "gi"),
      "$1",
    );
  }
  return out.replace(/\s+,/g, ",").replace(/,\s*,/g, ",").replace(/\s{2,}/g, " ");
}

/**
 * Deterministic character lock: whichever API key renders this scene, the same
 * fixed traits are appended verbatim, so characters never drift between shots.
 * The sheet is text only — it is injected as traits, never drawn as a sheet.
 */
export function characterLock(prompt: string, bible?: string): string {
  if (!bible) return "";
  const entries = parseBible(bible);
  if (entries.length === 0) return "";
  // NAMED CHARACTERS ONLY. The old pronoun fallback pulled a main character
  // into any panel containing "he"/"she" — including panels about soldiers,
  // crowds and strangers — which is exactly how narration lines turned into
  // generic "main couple standing somewhere" pictures. No name, no lock.
  const matched = entries.filter((e) => new RegExp(`\\b${escapeRe(e.name)}\\b`, "i").test(prompt));
  if (matched.length === 0) return "";

  // The lock is the single strongest consistency tool we have: it repeats each
  // named character's FIXED traits verbatim in every panel they appear in, and
  // then forbids the three things that actually drifted between shots —
  // clothing, gender and small facial/hair details.
  const traits = matched
    .map((e) => `${e.name}: ${e.traits.replace(/\.$/, "")}`)
    .join("; ");
  return (
    `Appearance lock (identical in every panel): ${traits}. ` +
    `Same exact outfit, same garment colours, same hairstyle and hair colour, same eye colour, ` +
    `same skin tone, same face shape, same gender and same age for each named person — ` +
    `never change, restyle, re-dress, re-age or swap the gender of a named character.`
  );
}

/**
 * Reads a character's age out of their bible line. Age drift was a top
 * complaint — the same "old lady" came back young in the next panel — so
 * whatever age the bible fixed is restated as an explicit render instruction.
 */
export function ageOf(traits: string): string {
  const t = traits.toLowerCase();
  const num = /\b(\d{1,2})\s*(?:-|\s)?(?:to|–|-)?\s*(\d{1,2})?\s*(?:-|\s)?year[s]?[- ]old\b/.exec(
    t,
  );
  if (num) {
    const n = Number(num[1]);
    const look =
      n >= 65
        ? "elderly, deeply wrinkled, grey-haired"
        : n >= 50
          ? "visibly older, lined face, greying hair"
          : n >= 38
            ? "clearly middle-aged, faint lines on the face"
            : n >= 25
              ? "a grown adult"
              : n >= 19
                ? "a young adult"
                : "";
    const label = num[2] ? `${num[1]}-to-${num[2]}-year-old` : `${num[1]}-year-old`;
    return look ? `${label} ${look}` : label;
  }
  const bands: [RegExp, string][] = [
    [
      /\b(elderly|old|aged|ancient|grand(mother|father|ma|pa)|buzurg|budhi|budha)\b/,
      "elderly, clearly aged 65 or older, with deeply wrinkled skin, sagging features and grey or white hair",
    ],
    [
      /\b(middle[- ]aged|forties|fifties|40s|50s)\b/,
      "middle-aged, clearly 40 to 55, with faint lines on the face",
    ],
    [/\b(young adult|twenties|thirties|20s|30s)\b/, "a young adult in their twenties or thirties"],
    [/\b(teen(age[rd]?)?|adolescent|schoolboy|schoolgirl)\b/, "a teenager, clearly 13 to 18"],
    [/\b(child|kid|little (boy|girl)|toddler|infant|baby)\b/, "a young child"],
  ];
  for (const [re, label] of bands) if (re.test(t)) return label;
  return "";
}

/** True when the prompt describes at least one human in frame. */
export function hasPeople(prompt: string, bible?: string): boolean {
  const p = prompt.toLowerCase();
  if (/\bno (people|figures?|characters?|humans?)\b|\bempty environment\b|\bunpopulated\b/.test(p))
    return false;
  if (
    bible &&
    parseBible(bible).some((e) => new RegExp(`\\b${escapeRe(e.name)}\\b`, "i").test(prompt))
  )
    return true;
  return /\b(man|men|woman|women|boy|boys|girl|girls|child|children|person|people|crowd|figure|silhouette|soldier|guard|villager|student|teacher|shopkeeper|worker|stranger|face|faces|he|she|they)\b/.test(
    p,
  );
}

/**
 * Hard budget for what actually reaches the image model.
 *
 * Flux reads the prompt through TWO encoders: T5 (~256 tokens, ~1000 chars)
 * and CLIP, which sees ONLY the first ~77 tokens (~300 chars). Whatever sits
 * in those first 300 characters is what the picture is "about".
 *
 * The old composition opened with a 200-character style block whose nouns
 * were "large expressive anime eyes and stylised anime faces" — so for CLIP
 * almost every panel was a request for an anime face, and the story moment
 * only started at character ~230. Depending on the seed, the renderer then
 * drew a generic anime close-up (a random girl's face, a grinning boy) with
 * nothing of the line in it. A retry on a new seed sometimes landed on the
 * scene instead, which made the fault look random. Same prompt, same code
 * path — the composition itself was the cause.
 *
 * So: the STORY MOMENT comes first, after only a five-word medium tag, and
 * the style words never name eyes or faces. Style is restated compactly at
 * the end, inside the T5 window.
 */
// Flux reads the prompt with T5 (512 tokens, roughly 2000 characters), so a
// 1250-character cap was throwing away the end of every prompt — which is
// exactly where each character's hair, skin and clothing sat. That truncation,
// not the wording, is why people changed appearance from picture to picture.
const IMAGE_PROMPT_BUDGET = 1900;
// Flux CLIP gives the first ~300 characters the strongest influence. Keep the
// exact action inside that window rather than allowing decorative detail to
// displace it.
const SCENE_BUDGET = 640;
// The lock used to be clipped at 150 chars, which cut most characters' traits
// (clothing colours sit at the END of a bible line) — that truncation is the
// main reason outfits and minor looks drifted panel to panel.
const LOCK_BUDGET = 260;

/**
 * Removes writing-model bookkeeping from a prompt before it reaches the
 * renderer. Written prompts arrived carrying their own line number and
 * timestamp ("3. [24s-31s] In the examination hall, ..."). Flux has no idea
 * that is metadata: it drew the digits into the picture and treated the
 * bracketed block as a caption, which is why panels came back with numbers,
 * stray lettering and sheet-like framing.
 */
function stripPromptMeta(p: string): string {
  return p
    // Instructions to the writing model are not drawable content.
    .replace(/\b(?:do not|don't|never|avoid|make sure|ensure|remember to)\b[^.]*\.?/gi, "")
    .replace(/\b(?:setting continuity|continuity|required cast|cast)\s*:\s*/gi, "")
    .replace(/^\s*\d{1,3}\s*[.)]\s*/, "")
    .replace(/\[\s*\d+\s*s?\s*(?:[-–—to]+\s*\d+\s*s?)?\s*\]/gi, "")
    .replace(/\b(?:timestamp|panel|shot|frame|line|scene)\s*#?\s*\d{1,3}\s*[:.)-]?\s*/gi, "")
    .replace(/\b\d{1,3}\s*s\s*[-–—]\s*\d{1,3}\s*s\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,.:;-]+/, "")
    .trim();
}

/** Collapses accidental word doubling ("young young spiky hair"). */
function dedupeWords(p: string): string {
  return p.replace(/\b(\w{3,})(\s+\1\b)+/gi, "$1");
}

/** Trims to a length without cutting mid-word. */
function clip(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(", "), cut.lastIndexOf(" "));
  return cut.slice(0, stop > max * 0.6 ? stop : max).replace(/[\s,.;-]+$/, "");
}

/**
 * Minimal medium tag. Just enough to keep Flux off its photographic default
 * without spending CLIP's short window on style nouns — and, critically,
 * without ever naming faces or eyes as things to draw.
 */
const STYLE_LEAD =
  "single full-bleed colour shonen manga illustration, one continuous picture filling the whole frame, of";

/**
 * The fixed look. This is appended AFTER the scene has been trimmed, never
 * inside the trimmed block: when it lived inside the clipped body it was the
 * first thing cut on a long scene, and those panels came back in a different
 * art style from their neighbours.
 */
const STYLE_TAIL =
  "bold shonen fighting manga artwork, heavy black ink outlines with dramatic hatching, halftone screentone shading, " +
  "deeply saturated vivid colours, glowing magical energy effects, motion lines on action, " +
  "high-contrast dramatic lighting, richly detailed fantastical background full of magical-world detail, " +
  "finished colour manga illustration drawn edge to edge, identical art style in every picture of this story";

/**
 * Anti-collage guard. Flux reads the word "manga" as permission to draw a
 * whole comic PAGE: several bordered panels with gutters and speech balloons.
 * Stated early, where CLIP still weighs it, and again at the very end.
 */
const SINGLE_FRAME_GUARD =
  "one single uninterrupted widescreen image, not a comic page, no panel borders, no gutters, " +
  "no split screens, no insets, no collage, no speech bubbles";


/**
 * ONE short identity line per character in frame.
 *
 * The old composition wrote each character twice: a compact "anchor" early and
 * then the full `characterLock` paragraph ("Appearance lock (identical in every
 * panel): ...") later. That repetition is what pushed Flux towards reference
 * sheets and isolated portraits — the prompt read more like a character sheet
 * than a scene. Now every character is described exactly once, briefly.
 */
function identityBrief(prompt: string, bible?: string): string {
  if (!bible) return "";
  // "Sora's room" is a place name, not a person in the picture. Counting it as
  // one put an extra character in the headcount and the renderer duly drew a
  // second person who is not in the scene.
  const present = prompt.replace(/\b([A-Za-z]+)'s\b/g, "the");
  const matched = parseBible(bible).filter((entry) =>
    new RegExp(`\\b${escapeRe(entry.name)}\\b`, "i").test(present),
  );
  if (matched.length === 0) return "";
  const shown = matched.slice(0, 3);
  const folded = prompt.toLocaleLowerCase();
  const briefs = shown.map((entry) => {
    // DESCRIBE EACH PERSON ONCE. The writing model already weaves a character's
    // hair, eyes and outfit into the scene sentence; repeating those traits here
    // read to Flux as a second, similar-looking person, and panels came back
    // with twin Kais and two Harutos. So when the scene already carries the
    // traits, this list contributes the NAME only.
    const traits = dedupeWords(entry.traits.replace(/\.$/, ""));
    const tokens = traits
      .toLocaleLowerCase()
      .match(/\b[a-z]{4,}\b/g)
      ?.filter((w) => !/(year|male|female|build|expression|posture|young|old)/.test(w));
    const already = (tokens ?? []).filter((w) => folded.includes(w)).length;
    return already >= 2 ? entry.name : `${entry.name} is ${clip(traits, 95)}`;
  });
  // An explicit headcount is what stopped the renderer inventing extra copies.
  const count =
    shown.length === 1 ? "exactly one person" : `exactly ${["", "one", "two", "three"][shown.length]} people`;
  return `${count} in this frame: ${briefs.join("; ")}`;
}

/**
 * Story staging. Flux's default for a described person is a front-facing
 * portrait looking straight at the viewer, so the intended staging is stated
 * positively and concretely instead of being left to the model.
 */
const STAGING_GUARD =
  "everyone absorbed in the action, eyes on each other, bodies turned into the scene at a three-quarter angle";

/**
 * Framing guard. Panels came back with a head cut off at the top edge or a
 * torso filling the frame, so the safe area is stated positively.
 */
const FRAMING_GUARD =
  "every figure framed complete with clear space around them, whole heads and bodies well inside the frame, nothing cut off by the edges";

/** Environment requirement — a scene, never a floating figure on blank paper. */
const BACKGROUND_GUARD =
  "a complete environment fills the background with depth, props and scenery around them";

/** Keep the timestamp's decisive place/subject/action sentence at the front. */
function openingBeat(prompt: string): { lead: string; rest: string } {
  const firstStop = prompt.search(/[.!?](?:\s|$)/);
  const end = firstStop >= 80 ? firstStop + 1 : Math.min(prompt.length, 210);
  return {
    lead: clip(prompt.slice(0, end), 220),
    rest: prompt.slice(end).trim(),
  };
}

export function composeImagePrompt(
  prompt: string,
  bible?: string,
  line?: string,
  /** The previous panel's place and cast, carried forward for continuity. */
  continuity?: string,
): string {
  bible = bible ? normalizeLeadCharacter(bible) : bible;
  const clean = stripPromptMeta(dedupeWords(prompt));
  const withCast = enforceLineCast(clean, line, bible);
  const fixed = collapseRepeatedIdentity(
    stripPromptMeta(enforceGender(sanitizePrompt(withCast), bible)),
    bible,
  );
  const peopled = hasPeople(fixed, bible);
  const beat = openingBeat(fixed);
  // Exactly ONE identity description per character, and only when someone is
  // actually in frame. No second appearance-lock paragraph.
  const identity = peopled ? clip(identityBrief(fixed, bible), LOCK_BUDGET) : "";

  // The place owns the very first words. A close-up line ("Close-up of Yuki
  // shouting") used to open the prompt with a face and nothing else, and the
  // renderer answered with a portrait floating in an invented backdrop. When
  // the running location is known and the line does not name its own, it is
  // stated before the action so the picture stays in the story's own place.
  const ownPlace = detectSetting(beat.lead);
  const carried = !ownPlace && continuity ? detectSetting(continuity) : null;
  const placeLead = carried ? `inside the same ${carried} as the previous picture, ` : "";

  // Order: the story moment, then WHO is in it, then the guards. Identity used
  // to sit behind the continuity sentence and was the first thing cut, so a
  // character arrived with no hair, skin or clothing description at all.
  const parts = [
    `${STYLE_LEAD} ${placeLead}${beat.lead}`,
    clip(beat.rest, Math.max(120, SCENE_BUDGET - beat.lead.length)),
    identity,
    // Stated early enough to matter: signage and captions crept in whenever
    // this sat at the very end of a long prompt.
    "completely wordless picture, no writing, signs, captions or letters anywhere",
    continuity
      ? clip(`same continuing scene, same location and same people as the previous picture: ${continuity}`, 220)
      : "",
    peopled ? STAGING_GUARD : "",
    peopled ? FRAMING_GUARD : "",
    peopled ? "each person drawn once only, no duplicates or twins" : "empty environment, no people in frame",
    BACKGROUND_GUARD,
  ].filter(Boolean);

  const tail = `${STYLE_TAIL}. ${SINGLE_FRAME_GUARD}`;
  // The style is never allowed to be trimmed away: the scene is clipped to
  // whatever room is left AFTER the fixed look is reserved, then the look is
  // appended. Every picture in a story therefore ends on the same words.
  const scene = clip(
    parts
      .join(". ")
      .replace(/\.\s*\./g, ".")
      .replace(/\s{2,}/g, " "),
    Math.max(200, IMAGE_PROMPT_BUDGET - tail.length - 2),
  );

  return `${scene}. ${tail}`;
}

/* ------------------------------------------------------------------ */
/* Quick size check                                                    */
/* ------------------------------------------------------------------ */

/** Anything smaller than this is not a real panel. */
const MIN_IMAGE_BYTES = 40_000;

/**
 * Fast sanity check: ask the server how big the file is. No download, no
 * entropy maths, no end-of-file probing — those were the slow part.
 */
async function isRealImage(url: string): Promise<boolean> {
  const gate = killableSignal(20_000);
  try {
    const res = await fetch(url, { method: "HEAD", signal: gate.signal });
    if (!res.ok) return true; // can't tell — keep the panel
    const len = Number(res.headers.get("content-length"));
    if (!Number.isFinite(len) || len === 0) return true;
    return len >= MIN_IMAGE_BYTES;
  } catch (e) {
    if (e instanceof KilledError) throw e;
    return true;
  } finally {
    gate.release();
  }
}


/** A wait that ends the moment the run is killed or the caller hangs up. */
async function pause(ms: number): Promise<void> {
  const step = 100;
  for (let waited = 0; waited < ms; waited += step) {
    assertActive();
    await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)));
  }
  assertActive();
}

/** Calls Flux.1 Schnell (free tier) at balanced quality/speed with retries. Always 16:9. */
export async function generateImage(
  prompt: string,
  seed: number,
  slot = 0,
  bible?: string,
  attempts = 6,
  line?: string,
  continuity?: string,
): Promise<string> {
  const body = composeImagePrompt(prompt, bible, line, continuity).slice(0, 2000);

  let lastErr = "";
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    // A killed run never spends another image credit.
    assertActive();
    // Each key renders three images at a time: this waits for capacity, so at
    // most thirty renders are ever in flight together.
    const url = await withImageKey(slot, attempt, async (key) => {
      const gate = killableSignal(IMAGE_REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(PIXAZO_URL, {
          method: "POST",
          signal: gate.signal,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
            "Ocp-Apim-Subscription-Key": key,
          },
          body: JSON.stringify({
            prompt: body,
            // Flux Schnell is distilled for four steps; extra steps do not fix
            // identity drift. Prompt order above is the quality control.
            num_steps: 4,
            // a fresh seed each attempt, so a blank frame is never re-rolled identically
            seed: seed + attempt * 977,
            width: 1344,
            height: 768,
          }),
        });
        if (res.ok) {
          const json = (await res.json()) as { output?: string };
          if (json.output) {
            if (await isRealImage(json.output)) return json.output;
            lastErr = "blank image rejected";
          } else {
            lastErr = "no output url";
          }
        } else {
          lastErr = `${res.status} ${await res.text().catch(() => "")}`.slice(0, 300);
        }
        if (lastErr) console.warn(`[pixazo] seed=${seed} attempt ${attempt + 1}: ${lastErr}`);
      } catch (e) {
        if (e instanceof KilledError) throw e;
        lastErr = e instanceof Error ? e.message : String(e);
        console.warn(`[pixazo] seed=${seed} attempt ${attempt + 1} threw: ${lastErr}`);
        assertActive();
      } finally {
        gate.release();
      }
      return null;
    });
    if (url) return url;
    // Short breather only: long back-offs made panels look stuck.
    await pause(100);
  }
  throw new Error(`Image generation failed: ${lastErr}`);
}

/* ------------------------------------------------------------------ */
/* Never-give-up render ladder                                         */
/* ------------------------------------------------------------------ */

/**
 * The ONLY permitted prompt rewrite: softening.
 *
 * A failed render is never shortened, truncated or reduced to a stub — that
 * produced generic, off-script panels. The full scene description is always
 * kept; the only rewrite replaces wording the free renderer refuses, and it is
 * applied only when the failure itself was a content refusal.
 */
export function promptVariant(prompt: string, level: number, _line?: string): string {
  const base = sanitizePrompt(prompt);
  if (level <= 0) return base;

  const soft: [RegExp, string][] = [
    [
      /\b(blood|bloody|bleeding|gore|gory|mutilated|dismembered|corpse|corpses|dead bodies?|severed)\b/gi,
      "aftermath",
    ],
    [
      /\b(kill(s|ing|ed)?|murder(s|ing|ed)?|slaughter(s|ing|ed)?|massacre(s|d)?|stab(s|bing|bed)?|torture(s|d)?)\b/gi,
      "attack",
    ],
    [/\b(naked|nude|nudity|topless|lingerie|seductive|sensual|erotic)\b/gi, "fully clothed"],
    [/\b(child|children|kid|kids|toddler|infant|baby)\b/gi, "young person"],
  ];
  let out = base;
  for (const [re, to] of soft) out = out.replace(re, to);
  return out.replace(/\s{2,}/g, " ").trim();
}

/**
 * Corrective rewrite used ONLY after the automatic review rejected a render.
 * Reroll changes the seed; this changes the composition, steering away from
 * the exact fault the reviewer named.
 */
export function correctiveVariant(prompt: string, reason: string): string {
  const fixes: Record<string, string> = {
    sketch: "fully finished, clean and polished production artwork with flat cel colour fills",
    sheet: "a single continuous story moment inside one real location, one appearance of each person",
    no_background:
      "a fully painted location filling the entire background with depth, furniture, props and scenery",
    facing_viewer:
      "characters turned into the scene at a three-quarter or profile angle, eyes on each other or on what they handle",
    duplicate: "each named person appears exactly once, whole separate bodies, clearly spaced apart",
    bad_crop:
      "a balanced medium or wide composition with every important character's complete head, face and body clearly inside the frame",
    underage_lead:
      "the main protagonist is unmistakably an adult 23-year-old unmarried young man, with mature adult facial proportions and adult height and build",
    wrong_scene: "exactly the location, cast and action described above and nothing else",
    text: "a completely wordless picture with no lettering anywhere",
  };
  const fix = fixes[reason.toLowerCase().trim()] ?? fixes["wrong_scene"];
  return `${prompt}. Composition correction: ${fix}.`;
}

/** True when the renderer refused the wording rather than simply failing. */
function contentRefusal(message: string): boolean {
  return /nsfw|safety|moderat|blocked|prohibit|forbidden|policy|inappropriate|not allowed|flagged|400|422/i.test(
    message,
  );
}


/**
 * Renders one panel with the FULL prompt.
 *
 * A failure is simply retried with the same complete prompt on a fresh seed and
 * the next image key. The prompt is never shortened or replaced by a stub; the
 * only rewrite is a softened version of the same full scene, and only when the
 * renderer refused the wording on content grounds.
 */

export async function renderPanel(
  written: string,
  seed: number,
  slot = 0,
  bible?: string,
  line?: string,
  timestamp?: string,
  /** Previous panel's place and cast, so a reroll cannot relocate the scene. */
  continuity?: string,
): Promise<{
  url: string;
  prompt: string;
  level: number;
  tries: number;
  rewritten: boolean;
}> {
  const errors: string[] = [];
  let tries = 0;

  // NO TEXT OR VISION CALLS ON THE RENDER PATH.
  //
  // Prompt writing already receives each exact timestamp and its own script
  // line, so the prompt is drawn as written. Both the prompt re-check and the
  // post-render image review are gone: they added one rate-limited request per
  // panel and were the slowest part of a long run. Quality is controlled by the
  // prompt composition in composeImagePrompt instead.
  const prompt = written;
  const rewritten = false;
  void timestamp;

  // Stage 1 — the prompt exactly as written, retried in full on fresh seeds and
  // fresh keys. Each round itself retries inside generateImage, so a busy or
  // flaky renderer is worked through instead of failing the panel.
  let refused = false;
  for (let round = 0; round < 3; round++) {
    tries++;
    try {
      const url = await generateImage(
        prompt,
        seed + round * 1861,
        slot + round,
        bible,
        3,
        line,
        continuity,
      );
      return { url, prompt, level: 0, tries, rewritten };
    } catch (e) {
      if (e instanceof KilledError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`round ${round + 1}: ${msg}`);
      if (contentRefusal(msg)) refused = true;
    }
    await pause(400 * (round + 1));
  }
  // Stage 2 — softened wording (same scene, same length). Tried whenever the
  // full prompt could not be rendered, not only on an explicit refusal: a free
  // renderer often reports a content block as a plain failure.
  const softened = promptVariant(prompt, 1, line);
  if (softened && softened !== prompt) {
    for (let round = 0; round < (refused ? 3 : 2); round++) {
      tries++;
      try {
        const url = await generateImage(
          softened,
          seed + 5471 + round * 977,
          slot + round,
          bible,
          3,
          line,
          continuity,
        );
        return { url, prompt: softened, level: 1, tries, rewritten };
      } catch (e) {
        if (e instanceof KilledError) throw e;
        errors.push(`softened ${round + 1}: ${e instanceof Error ? e.message : String(e)}`);
      }
      await pause(500 * (round + 1));
    }
  }

  // Stage 3 — last resort: the same scene rendered in the plainest possible
  // wording, so a panel is produced rather than a hole in the story.
  const plain = sanitizePrompt(softened || prompt)
    .replace(/["'“”‘’]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 900);
  if (plain.length >= 20) {
    for (let round = 0; round < 3; round++) {
      tries++;
      try {
        const url = await generateImage(plain, seed + 9109 + round * 613, slot + round, bible, 3, line, continuity);
        return { url, prompt: plain, level: 2, tries, rewritten };
      } catch (e) {
        if (e instanceof KilledError) throw e;
        errors.push(`plain ${round + 1}: ${e instanceof Error ? e.message : String(e)}`);
      }
      await pause(600 * (round + 1));
    }
  }

  throw new Error(`Image generation failed after ${tries} tries — ${errors.slice(-2).join(" | ")}`);

}


