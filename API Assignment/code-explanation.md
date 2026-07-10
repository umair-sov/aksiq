# Understanding Your First Program — A Beginner's Guide

Welcome! This document walks through the code in `index.js` line by line, as if you have never programmed before. By the end, you will understand what the code does, and you will also know the core building blocks of programming: variables, functions, loops, conditionals, floats, doubles, booleans, strings, and characters.

Take your time. Nothing here assumes prior knowledge.

---

## 1. What Is a Program?

A **program** is a list of instructions that a computer follows, one after another, in the exact order you write them.

Think of a program as a **recipe**.
- A recipe tells a cook what ingredients to gather, and what steps to do in what order.
- A program tells a computer what data to gather, and what steps to do in what order.

The computer is extremely fast, but also extremely literal. It does exactly what you tell it — nothing more, nothing less. If you forget a step, the computer will not "figure it out." So programming is really the art of writing precise, unambiguous instructions.

A **programming language** (like JavaScript, which is what our file uses) is just a set of words and rules that both you and the computer can agree on. You write your instructions in that language, and the computer translates them into something it can execute.

---

## 2. The Code We Are Explaining

Here is the full contents of `index.js`:

```javascript
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

async function main () {
    const response = await client.messages.create ({
        model: 'claude-sonnet-4-5',
        max_tokens: 256,
        messages: [
            { role: 'user', content: 'Say hello and tell me one fact about APIs.' }
        ],
    });

    console.log(response.content[0].text);

}

main();
```

In plain English, this program:
1. Talks to Anthropic's Claude AI over the internet.
2. Asks Claude to say hello and share one fact about APIs.
3. Prints Claude's reply into the terminal (your black text window).

Now let's go line by line.

---

## 3. Line-By-Line Explanation

### Line 1 — `import 'dotenv/config';`

This line **loads a helper tool** called `dotenv`. Its job is to read a hidden file called `.env` in your project and load the secret values inside it (like your API key — think of it as a password) into the program's environment.

Why? Because you should **never** write secret passwords directly in your code. Anyone who sees the code would see your secret. Instead, we keep secrets in `.env` and this line pulls them in quietly.

**Analogy:** Before you start cooking, you unlock the pantry so you can reach the salt. `dotenv/config` unlocks the pantry.

### Line 2 — `import Anthropic from '@anthropic-ai/sdk';`

This **imports** (brings in) a library called the Anthropic SDK. A **library** is a bundle of pre-written code that someone else built, so we don't have to build it ourselves.

The Anthropic SDK is a toolkit that knows how to talk to Anthropic's servers where Claude the AI lives. Without it, we'd have to write hundreds of lines of code just to send a message.

**Analogy:** Instead of building your own oven from scratch, you install one from the store. `import` is you installing that oven.

The name `Anthropic` is what we will call this toolkit inside our code.

### Line 3 — *(blank line)*

Blank lines do nothing. They exist just to make code easier for humans to read, like paragraph breaks in a book.

### Line 4 — `const client = new Anthropic();`

This line does three things at once:

1. `new Anthropic()` — creates a fresh, ready-to-use **client** object. Think of it as opening a phone line to Anthropic's servers.
2. `const client =` — gives that phone line a nickname: `client`. Now anywhere we type `client`, we mean this phone line.
3. `const` — locks the nickname. It says "this name always refers to this same phone line; don't reassign it to something else."

The `;` at the end is a period. It tells the computer, "this instruction is finished."

### Line 5 — *(blank line)*

Just a spacer for readability.

### Line 6 — `async function main () {`

This begins the definition of a **function** called `main`.

- `function` is the keyword that says "I'm about to define a reusable set of steps."
- `main` is the name we chose for this set of steps.
- `()` is where inputs would go (this function takes none).
- `{` opens the block of steps that make up the function.
- `async` is a special word that says: "this function will do something that takes time (like waiting for a reply from the internet), and that's okay — the program can pause and wait patiently."

Nothing runs yet! Defining a function is like writing a recipe on a card. You still have to tell someone to actually cook it later. (That happens on line 19.)

### Line 7 — `const response = await client.messages.create ({`

Several things happen here:

- `client.messages.create(...)` — this **calls** (uses) a function that belongs to our `client` object. It literally means "hey Anthropic client, please create a new message." Whatever we pass inside the parentheses `(...)` is the details of what we want.
- `await` — this word says "pause here and wait for the reply before doing anything else." Talking to the internet takes time (maybe half a second, maybe five seconds). `await` makes sure we don't move on until Claude has answered.
- `const response =` — when the reply arrives, store it under the nickname `response`.
- `{` at the end opens up a block that describes the details of our request. Those details span lines 8 through 12.

### Line 8 — `model: 'claude-sonnet-4-5',`

This is one setting inside our request.

- `model` is the name of the setting.
- `'claude-sonnet-4-5'` is the value — it names which version of Claude we want to talk to. Claude has different models (some faster, some smarter). We are choosing "Sonnet 4.5."
- The text between the single quotes `'...'` is called a **string**. More on strings later.
- The `,` at the end simply means "there's another setting coming next."

### Line 9 — `max_tokens: 256,`

Another setting.

- `max_tokens` is the maximum length of Claude's reply.
- A **token** is roughly a small chunk of text — often a short word or a piece of a word. So 256 tokens is about a paragraph or two.
- `256` is a plain **number**. Numbers do not need quotes.

This is basically saying: "please don't write me a novel — cap your reply at about a paragraph."

### Line 10 — `messages: [`

Another setting: `messages`. This one is a **list** (also called an **array**) of messages we want to send Claude. A list is denoted by the square brackets `[ ]`.

Right now we're going to put one message inside. But the list format lets us have full back-and-forth conversations if we want.

### Line 11 — `{ role: 'user', content: 'Say hello and tell me one fact about APIs.' }`

This is a single message. It has two parts wrapped inside `{ ... }`:

- `role: 'user'` — who is speaking. Here, it's `'user'` (that's us, the human sending a request). Claude will interpret this as "the human said the following."
- `content: 'Say hello and tell me one fact about APIs.'` — the actual text of what we said.

Both values are strings (in quotes).

### Line 12 — `],`

- `]` closes the list of messages that we opened on line 10.
- `,` says "and there might be more settings after this." (There aren't in our case, but the comma is harmless.)

### Line 13 — `});`

- `}` closes the block of settings we opened on line 7.
- `)` closes the parentheses of the `client.messages.create(...)` call, also from line 7.
- `;` ends the whole instruction.

At this point in the program, Claude has replied, and its reply is stored under the nickname `response`.

### Line 14 — *(blank line)*

Spacer.

### Line 15 — `console.log(response.content[0].text);`

This line **prints** Claude's reply into your terminal window.

- `console.log(...)` is a built-in function. Everything you put inside its parentheses will be shown on the screen.
- `response` is the reply we got from Claude.
- `response.content` — inside the reply, there's a piece named `content`. This is a list of "blocks" of content. (Claude can return text, images, and other things, so it wraps everything in blocks.)
- `[0]` — grab the very first block. In programming, we count starting at `0`, not `1`. So `[0]` means "the first item."
- `.text` — take the actual text from that block.

Put together: "print the text of the first content block of Claude's reply." That's the message we see on screen.

### Line 16 — *(blank line)*

Spacer.

### Line 17 — `}`

This closes the `main` function that we opened on line 6. Everything between `{` (line 6) and `}` (line 17) is the body of `main`.

### Line 18 — *(blank line)*

Spacer.

### Line 19 — `main();`

Remember, defining a function on lines 6–17 just wrote the recipe. **This line actually cooks the recipe.** The `()` means "run it now, please."

Without this line, the program would define `main` and then… do nothing. This line is the ignition switch.

### Line 20 — *(blank line at the very end)*

Files usually end with a blank line by convention. Harmless.

---

## 4. Core Programming Concepts

Now that you've seen the code, let's zoom out and cover the fundamental ideas of programming. Some of these appear in our file. Some don't — but you'll see them soon in future assignments, so it's good to know them.

### 4.1 Variables

A **variable** is a labeled container that holds a piece of data. You give the container a name, and later you can refer to what's inside by using that name.

**Analogy:** Imagine a box in your garage labeled "Christmas Lights." The label is the variable's name. What's inside is the variable's value. When someone says "grab the Christmas Lights," you know exactly which box to open.

In our code:
- **Line 4:** `const client = new Anthropic();` — `client` is a variable holding our connection to Anthropic.
- **Line 7:** `const response = await client.messages.create(...);` — `response` is a variable holding Claude's reply.

`const` means the label is glued on. You can't move the label to a different box. In JavaScript, other keywords like `let` and `var` also create variables but allow you to change what's inside; `const` is the safest and most common choice when you don't intend to change the value.

### 4.2 Functions

A **function** is a reusable, named set of instructions. You write the steps once, give them a name, and then you can trigger them as many times as you want.

**Analogy:** A microwave has a "Popcorn" button. You didn't design the button — someone else did — but you can press it any time. Pressing the button runs a set of pre-programmed steps. That button is a function.

In our code:
- **Line 6:** `async function main () { ... }` defines a function called `main` — this is a recipe *we* wrote.
- **Line 19:** `main();` calls (runs) that function.
- **Line 7:** `client.messages.create(...)` calls a function that already existed inside the Anthropic library.
- **Line 15:** `console.log(...)` calls a function that comes built into JavaScript itself.

Functions often take **inputs** (called arguments, placed in the parentheses) and often return an **output**. On line 7, the input is the giant `{ ... }` block of settings, and the output — after `await` — is Claude's reply, which we save into `response`.

### 4.3 Loops

A **loop** is a way to repeat the same instruction many times without writing it out many times.

**Analogy:** Brushing your teeth. You don't think, "brush tooth 1, brush tooth 2, brush tooth 3…" You think, "for each tooth, brush it." A loop is the "for each" idea.

We do **not** have a loop in `index.js`. But here's what one looks like in JavaScript:

```javascript
for (let i = 1; i <= 5; i++) {
    console.log('Hello number ' + i);
}
```

This would print:

```
Hello number 1
Hello number 2
Hello number 3
Hello number 4
Hello number 5
```

You'd use a loop when you have a list of things (say, ten users) and you want to do the same action for each one (say, send them all an email).

### 4.4 Conditionals

A **conditional** is a way to make the computer choose between paths based on whether something is true or false.

**Analogy:** "If it's raining, take an umbrella. Otherwise, don't." That's a conditional.

We do **not** have a conditional in `index.js`. In JavaScript, a conditional looks like:

```javascript
if (response.content[0].text.length > 100) {
    console.log('Claude wrote a long reply.');
} else {
    console.log('Claude was brief.');
}
```

This would inspect Claude's reply and print one of two things depending on how long it is. `if` starts the check, and `else` covers the "otherwise" case. Conditionals are how programs make decisions.

### 4.5 Floats

A **float** (short for "floating-point number") is a number with a decimal point in it — like `3.14`, `0.5`, or `-2.75`.

The word "floating" refers to how the decimal point can "float" to any position: sometimes we care about `3.14`, sometimes about `0.0000314`. Floats can represent both.

We do **not** use floats in `index.js` — our only number is `256` on line 9, which is a whole number (called an **integer**).

**Example of a float:**

```javascript
const price = 9.99;
```

### 4.6 Doubles

A **double** is *also* a decimal number, but stored with **double the precision** of a float. In many languages (like Java, C++, C#), you must choose whether a decimal number should be a `float` or a `double`:
- `float` uses less memory but is less precise.
- `double` uses more memory but is more precise.

**Important note about JavaScript:** JavaScript, the language our file is written in, does not make you choose. It has only *one* kind of number, and under the hood it is always a double. So when you write `256` or `9.99` in JavaScript, you're actually using a double whether you realize it or not.

So on **line 9** of our code, `256` is technically stored as a double, even though it looks like a simple whole number.

### 4.7 Boolean

A **boolean** is a value that can only be one of two things: `true` or `false`. Nothing else — no maybe, no in-between.

**Analogy:** A light switch: on or off. A door: locked or unlocked.

We do **not** use a boolean directly in `index.js`. But every conditional (see 4.4) is really a hidden boolean question: "is this true or false?"

**Example:**

```javascript
const isFinished = true;
if (isFinished) {
    console.log('All done!');
}
```

Booleans are the foundation of all decision-making in code.

### 4.8 String

A **string** is a piece of text. Anything you type between quotation marks becomes a string. It could be a single letter, a word, a full sentence, or even an empty pair of quotes with nothing between them.

**Analogy:** A string is a bead necklace. Each bead is a letter, and the string holds them in order: `H` `e` `l` `l` `o`.

In JavaScript you can use single quotes `'...'`, double quotes `"..."`, or backticks `` `...` ``. In our file we use single quotes.

**Strings in our code:**
- **Line 1:** `'dotenv/config'`
- **Line 2:** `'@anthropic-ai/sdk'`
- **Line 8:** `'claude-sonnet-4-5'`
- **Line 11:** `'user'` and `'Say hello and tell me one fact about APIs.'`

That last one is the actual message we're sending to Claude — the entire question is just one string.

### 4.9 Char

A **char** (short for "character") is a **single** character — one letter, one digit, one symbol, one space. Just one.

**Analogy:** If a string is a whole necklace of beads, a char is a single bead.

**Important note about JavaScript:** JavaScript does not have a separate `char` type. Even if you write a single letter, it's still just a string of length 1.

```javascript
const letter = 'A'; // JavaScript treats this as a string, not a char
```

Languages like C, C++, C#, and Java *do* have a real `char` type, and usually you write chars using single quotes (`'A'`) and strings using double quotes (`"Hello"`). But in JavaScript, single and double quotes both make strings.

So while `index.js` has no chars in the strict sense, if you look at a single letter of any of our strings — the `S` at the start of `'Say hello...'` — that single letter is what other languages would call a char.

---

## 5. Why Does the Syntax Look So Strange?

If English is what you speak, code can look like someone spilled a bowl of punctuation onto a page. Curly braces, semicolons, dots, commas, arrows — where does it all come from, and why does it have to be this way? This section explains it.

### 5.1 Why Syntax Exists At All

**Syntax** is the grammar of a programming language — the rules about *how* you're allowed to arrange the words and symbols. Every programming language has strict syntax rules, and there are two big reasons why.

**Reason 1: Computers are extremely literal.** When you speak English to another person, they can guess your meaning even if you leave things out. If you say, "grab the book on the table," a friend knows what you mean even if there are two tables. Computers cannot guess. They need every instruction to have exactly one possible interpretation.

**Reason 2: Symbols are unambiguous.** English words can mean many things ("run" can be a verb, a noun, or a description of a stocking). Symbols like `{`, `[`, `(`, and `;` were picked precisely because they don't mean anything else. When the computer sees `{`, it knows *for certain* what job that symbol is doing.

So syntax is not there to torture you. It is there so that both you and the computer can agree, without any doubt, on what your program is asking for.

Now let's break down each family of symbols in `index.js`.

### 5.2 The Three Kinds of Brackets

JavaScript uses three different bracket shapes, and each shape has a **completely different job**. Learning which is which is one of the biggest early wins in programming.

| Bracket | Name | Main Jobs |
|---|---|---|
| `( )` | Parentheses / Round brackets | Calling a function; listing function inputs; grouping math |
| `{ }` | Curly braces / Curly brackets | Grouping a block of instructions; defining an object |
| `[ ]` | Square brackets | Making a list (array); grabbing an item by position |

Let's look at each in detail, with examples from our file.

### 5.3 Parentheses `( )` — Round Brackets

Parentheses have three main uses.

**Job A — Calling a function.** When you want to *run* a function, you put `()` after its name.

- **Line 19:** `main();` — the `()` here is what actually runs `main`. Without the `()`, you'd just be pointing at the function, not executing it. Think of it like the difference between *looking at* a doorbell and *pressing* the doorbell. The `()` is the press.
- **Line 4:** `new Anthropic()` — the `()` runs the Anthropic setup.
- **Line 7:** `client.messages.create( ... )` — the `()` runs the `create` function, and whatever we put *inside* the parentheses becomes the input to that function.
- **Line 15:** `console.log( ... )` — the `()` runs `console.log`, and whatever is inside is what gets printed.

**Job B — Defining a function's inputs.** When you *define* a function, the parentheses hold the list of inputs that function will accept.

- **Line 6:** `async function main () {` — the `()` here is *empty* because `main` accepts no inputs. It's still required though. Leaving it out would be like writing a recipe without saying whether it has ingredients — the language demands the parentheses so it knows for sure.

**Job C — Grouping in math (not in our file, but worth knowing).** Just like in normal math, `(2 + 3) * 4` forces the addition to happen before the multiplication. Parentheses in programming do the same thing.

**Rule of thumb for parentheses:** if you're doing something with a function (either running it or defining its inputs), you want `()`.

### 5.4 Curly Braces `{ }` — Curly Brackets

Curly braces also have two main uses, and beginners often mix them up. Watch closely.

**Job A — Grouping a block of instructions.** When you write a function, an `if` statement, or a loop, the instructions that "belong to" it are wrapped in `{ }`. Everything between the opening `{` and matching closing `}` is one indivisible group.

- **Line 6 opens** `async function main () {` and **line 17 closes** `}`. Everything between them is the body of `main` — the actual steps of the recipe. Without those braces, JavaScript wouldn't know where the function's instructions end.

Think of `{ }` as a fence around a herd of sheep. The fence tells you exactly which sheep belong together.

**Job B — Defining an object (key-value pairs).** JavaScript uses `{ }` for a totally different purpose too: making an **object**. An object is a bundle of labels (called **keys**) and values, written as `key: value` separated by commas.

- **Line 7 opens** `create( {` and **line 13 closes** `} )`. That whole block between the braces is a single object describing our request. Its keys are `model`, `max_tokens`, and `messages`.
- **Line 11:** `{ role: 'user', content: 'Say hello...' }` is another object — this one representing one message. Its keys are `role` and `content`.

So how do you know if `{ }` is a code block or an object? **Look at what's inside.**
- If you see instructions and semicolons → code block.
- If you see `key: value` pairs separated by commas → object.

**Rule of thumb for curly braces:** if you're grouping instructions *or* labeling values, you want `{ }`.

### 5.5 Square Brackets `[ ]`

Square brackets also have two uses.

**Job A — Making a list (array).** An **array** is an ordered list of items. You write it inside `[ ]`, with items separated by commas.

- **Line 10:** `messages: [` opens a list of messages, and **line 12** closes it with `]`. Between them lives one message (from line 11). If we wanted a longer conversation, we could put many message objects in this list, separated by commas.

**Job B — Grabbing one item from a list by its position (indexing).** When you already have a list and want a specific item from it, you put its position number inside `[ ]` right after the list.

- **Line 15:** `response.content[0]` — this means "give me item number `0` (the first item) from the `content` list." Remember, computers count from 0, not 1.

So `[ ]` either **creates** a list (when the items are inside it) or **picks from** a list (when there's just one number inside it, placed after another value).

**Rule of thumb for square brackets:** if you're dealing with a list or a position in a list, you want `[ ]`.

### 5.6 Bracket Quick-Reference

Here is the same information in one glance, using tiny examples:

```javascript
// Parentheses () — calling / defining a function
main();                                // call
function greet(name) { }               // define with inputs

// Curly braces {} — code block OR object
if (true) {                            // code block
    console.log('hi');
}
const person = { name: 'Ada', age: 30 };   // object

// Square brackets [] — array OR pick by position
const colors = ['red', 'green', 'blue'];   // array
console.log(colors[1]);                    // pick — prints "green"
```

**The single most important habit:** every opening bracket needs a matching closing bracket of the same kind. `(` matches `)`, `{` matches `}`, `[` matches `]`. Never mixed. A missing or wrong bracket is one of the most common causes of errors when you're starting out. Editors like VS Code will highlight matches for you — trust that highlight.

### 5.7 The Other Punctuation

Brackets are the main event, but our file has other important symbols too. Here's what each one means and why it's there.

#### Semicolons `;` — End of an Instruction

A semicolon says, **"this instruction is complete; move on to the next one."** It plays the same role as a period at the end of an English sentence.

- **Line 1, 2, 4, 13, 15, 19** all end with `;`. Each is a single, complete instruction.

You'll notice the *middle* lines inside our object (lines 8, 9, 10, 12) do **not** use `;` — they use `,` instead. That's because they're pieces of a single instruction, not separate instructions. Only whole, standalone instructions get a `;`.

**Fun fact:** JavaScript will often forgive you if you forget a semicolon, but relying on that mercy is a bad habit. Type them.

#### Commas `,` — "And Here's Another One"

A comma is a separator. It says, **"one item ends here; another begins."**

- **Line 8, 9, 10, 12:** commas separate the key-value pairs inside an object.
- Inside `[ ... ]` arrays, commas would separate items too (we only have one item, so no comma is needed).

The rule: **inside `{ }` or `[ ]`, use commas between items. Between full instructions, use semicolons.**

#### Colons `:` — Pairing a Label to a Value

A colon links a **key** (the label) to its **value** (what it stores) inside an object.

- **Line 8:** `model: 'claude-sonnet-4-5'` — the key is `model`, the value is the string `'claude-sonnet-4-5'`.
- **Line 11:** `role: 'user'` and `content: '...'` — same idea.

If it helps, read `:` as the word "is." "Model *is* `'claude-sonnet-4-5'`." "Role *is* `'user'`."

#### Periods `.` — Reaching Inside

A period (or dot) means **"go inside this thing and grab what comes next."**

- **Line 7:** `client.messages.create` reads as: from `client`, get `messages`; from `messages`, get `create`. Then the `()` after it calls that `create` function.
- **Line 15:** `response.content[0].text` — from `response`, get `content`; from `content`, take item `[0]`; from that item, get `text`.

Think of it as opening nested boxes. Each `.` opens the next box inside.

#### Equals `=` — Assignment

A single `=` puts a value **into** a variable.

- **Line 4:** `const client = new Anthropic();` — the `=` takes what's on the right and stores it under the name on the left.
- **Line 7:** `const response = await client.messages.create(...);` — same story.

**Careful:** In programming, `=` does *not* mean "is equal to" the way it does in math. It means "put the right thing into the left thing." To *check* equality you use `===` (three equals signs) in JavaScript, but we don't do that in this file.

#### Quotes `' '` — Wrapping a String

Anything between quotes is a **string** (a piece of text). Quotes tell JavaScript, "treat what's inside as raw text, not as code."

- **Line 8:** `'claude-sonnet-4-5'` — the dashes and letters here are just text, not calculations.
- **Line 11:** `'Say hello and tell me one fact about APIs.'` — an entire English sentence, treated as one indivisible piece of text.

You can use single quotes `'...'`, double quotes `"..."`, or backticks `` `...` `` in JavaScript. All three make strings. Our file uses single quotes throughout, purely as a style choice. What matters is that the same style opens and closes each string.

### 5.8 One More Time — The Punctuation Cheat Sheet

Keep this near you until it feels natural:

| Symbol | Name | Job | Example |
|---|---|---|---|
| `( )` | Parentheses | Call a function, list its inputs, or group math | `main()`, `function f(x)` |
| `{ }` | Curly braces | Group instructions, or define an object | `function f() { ... }`, `{ a: 1 }` |
| `[ ]` | Square brackets | Make a list, or pick an item by position | `[1, 2, 3]`, `arr[0]` |
| `;` | Semicolon | End of one instruction | `main();` |
| `,` | Comma | Separate items in a list or object | `[1, 2, 3]` |
| `:` | Colon | Pair a key with a value in an object | `role: 'user'` |
| `.` | Period / Dot | Reach inside something to get a piece of it | `client.messages` |
| `=` | Equals | Store the right-hand value into the left-hand name | `const x = 5;` |
| `' '` `" "` `` ` ` `` | Quotes | Wrap a piece of text (string) | `'hello'` |

If a piece of the code confuses you, pause and ask: **which symbol is this, and what job is it doing here?** Nine times out of ten, the confusion disappears.

---

## 6. Putting It All Together

Here's the story of what happens when you run `node index.js`:

1. **Line 1** loads secrets from `.env` (like your API key).
2. **Line 2** brings in the Anthropic SDK toolkit.
3. **Line 4** creates a client — our connection to Claude.
4. **Lines 6–17** define a set of steps called `main`, but do not run them yet.
5. **Line 19** runs `main`. Inside `main`:
    - **Line 7** sends a request to Claude and waits for the reply.
    - **Lines 8–12** describe what we're asking: which model, how long the reply can be, and the actual question.
    - **Line 15** prints Claude's reply on the screen.

That is your entire first API program. Congratulations — you now understand every line, every symbol, and every core concept behind it.

---

## 7. Quick Glossary

| Term | Meaning | Example from our file |
|---|---|---|
| Program | Ordered list of instructions | The entire file |
| Import | Bring in outside code | `import Anthropic from '@anthropic-ai/sdk';` |
| Variable | A named container for a value | `client`, `response` |
| `const` | A variable whose label can't be reassigned | `const client = ...` |
| Function | A reusable set of steps | `main`, `console.log` |
| Argument | Input passed into a function | The big `{...}` block on line 7 |
| String | A piece of text in quotes | `'Say hello...'` |
| Number | A numeric value | `256` |
| Array / List | An ordered collection in `[ ]` | `messages: [ ... ]` |
| Object | A collection of `key: value` pairs in `{ }` | The message `{ role: ..., content: ... }` |
| `await` | Pause and wait for a slow operation | `await client.messages.create(...)` |
| `async` | Marks a function that uses `await` | `async function main()` |

Happy coding! Take small steps, break things on purpose, and remember: every experienced programmer was once staring at their very first program, exactly like you are now.
