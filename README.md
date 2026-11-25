# pension-calculator

Static calculator comparing Finnish and Estonian pensions, with a move between the two, against investing the same contributions.

Live: https://pension-calculator-pied.vercel.app

No build step: `index.html`, `style.css`, `app.js`. The engine in `app.js` also loads in Node (`require("./app.js").simulate`).
