# Brian Yildirim: Personal Portfolio

A responsive personal portfolio website for a software engineer focused on systems engineering, backend development, and full-stack applications.

The portfolio highlights selected projects, professional experience, coursework, technical skills, and ways to get in touch.

## Live Portfolio

[View the portfolio](https://brianyildirim.com/)

## Features

* Responsive layout for desktop, tablet, and mobile screens
* Client-side navigation between portfolio sections
* About section with featured projects and technical skills
* Project showcase with category filtering
* Experience timeline
* Coursework overview focused on software engineering and computer science
* Resume, GitHub, LinkedIn, and email links
* Semantic HTML with alt text on images
* No external framework or build system required

## Portfolio Sections

### About

Introduces Brian's background, engineering interests, featured projects, technical skills, and interests outside of programming.

### Projects

Highlights five projects across full-stack, systems, and backend development:

* **StrivoAI** — Career intelligence platform built with TypeScript, React, Supabase, PostgreSQL, and Stripe
* **Minecraft Enchantment Calculator** — Recursive optimization tool built with Python and Flask
* **Rate Limiter Library** — Sharded C++ token-bucket rate limiter
* **Image Quality Gate** — FastAPI microservice for detecting low-quality images
* **Concurrent Key-Value Server** — Multithreaded TCP key-value store with persistence

### Coursework

Covers coursework in:

* Data Structures and Algorithms
* Software Testing
* Systems Engineering
* Object-Oriented Programming
* Statistical Data Analysis
* Linear Algebra
* Discrete Mathematics
* Calculus II

## Technology

This portfolio is intentionally lightweight and uses browser-native technologies:

* HTML5
* CSS3
* Vanilla JavaScript
* Responsive design
* Static assets
* Client-side DOM manipulation
* GitHub Pages-compatible hosting

## Project Structure

```text
portfolio/
├── index.html                      # Main page shell and navigation
├── main.js                         # Client-side routing and project filtering
├── pages/
│   ├── about.html                  # About section
│   ├── projects.html               # Project showcase
│   ├── experience.html             # Experience timeline
│   ├── coursework.html             # Coursework overview
│   └── projects/                   # Case-study partials, loaded into the project panel
│       ├── strivoai.html
│       ├── enchantment-calculator.html
│       ├── rate-limiter.html
│       ├── image-quality-gate.html
│       └── kv-server.html
├── scripts/
│   ├── project-detail.js           # Project panel and its project registry
│   └── demos/                      # Interactive demos, each with its engine
│       ├── ratelimit.js
│       ├── ratelimit-core.js
│       ├── iqg.js
│       ├── iqg-core.js
│       ├── iqg-worker.js
│       ├── kv.js
│       └── kv-core.js
├── styles/
│   ├── main.css                    # Global styles and responsive layout
│   └── project-detail.css          # Project panel and demo styles
├── static/                         # Images, favicon, and resume
└── readme.md
```

## Running Locally

Because this site loads page content with JavaScript, it should be served through a local web server rather than opened directly with `file://`.

### Option 1: Python

```Shell
git clone https://github.com/BrianKYildirim/portfolio.git
cd portfolio
python3 -m http.server 8000
```

Then open <http://localhost:8000> in your browser.

### Option 2: Visual Studio Code

1. Clone the repository.
2. Open the project in Visual Studio Code.
3. Install the **Live Server** extension.
4. Right-click `index.html`.
5. Select **Open with Live Server**.

## Customization

To update the portfolio:

* Edit `pages/about.html` to change the introduction, skills, or featured projects.
* Edit `pages/projects.html` to add or update projects.
* Edit the case-study partials in `pages/projects/` to change a project's write-up.
* Register a case study and its demo in the registry in `scripts/project-detail.js`.
* Edit `pages/experience.html` to update professional experience.
* Edit `pages/coursework.html` to change the education section.
* Edit `styles/main.css` to change the visual design.
* Edit `styles/project-detail.css` to change the project panel and demo styles.
* Edit `main.js` to modify navigation or project filtering behavior.
* Replace files in `static/` to update images, the favicon, or resume.

## Contact

* **Email:** <byildiri@uci.edu>
* **GitHub:** [github.com/BrianKYildirim](https://github.com/BrianKYildirim)
* **LinkedIn:** [linkedin.com/in/brianyildirim](https://www.linkedin.com/in/brianyildirim/)

***

Built with HTML, CSS, and JavaScript by **Brian Yildirim**.
