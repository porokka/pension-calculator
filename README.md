# pension-calculator

Static calculator comparing Finnish, Estonian, Belgian and Swiss pensions after tax, with a chain of moves between them, against investing the same contributions.

Live: https://pension-calculator-pied.vercel.app

No build step: `index.html`, `style.css`, `app.js`. The engine in `app.js` also loads in Node (`require("./app.js").simulate`).
