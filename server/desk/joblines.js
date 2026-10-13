/**
 * joblines.js — what each person actually does all day, in their own voice.
 *
 * Used for walk-up / click-to-talk conversations when the LLM is off: what
 * they're working on, a status update from their desk, and their take when
 * Michael asks for an opinion. Lines use the latest book on the desk when
 * there is one (b = { client, total, top, second, breaches, n }).
 */

const pick = a => a[Math.floor(Math.random() * a.length)]

/** slug → { work: [(b) => line], advice: [(b) => line] } — "work" = what I'm on / status; "advice" = my professional take */
export const JOB = {
  'jim-halpert': {
    work: [
      b => b?.top ? `Building the trade list for ${b.client}. If we trim ${b.top.ticker}, I'll split it into clips so we don't move the price.` : 'Lining up the execution plan for the next book. Limit orders, small clips, nothing fancy.',
      () => "Checking yesterday's fills against VWAP. We beat it. Barely. I'm counting it.",
      () => 'Watching spreads into the open. Wide spreads, small orders. That\'s the whole secret.',
    ],
    advice: [
      () => "Honestly? Decide the size first, then the price. Most bad trades are just good ideas that were too big.",
      () => 'Use limit orders. Market orders are how Dwight bought a beet farm at the ask.',
    ],
  },
  'dwight-schrute': {
    work: [
      b => b?.top ? `Running stress tests on ${b.client}'s book. ${b.top.ticker} at ${b.top.weight}% fails three of my five doomsday scenarios. The other two involve bears.` : 'Running stress tests. Scenario four: a 2008-style crash during a blizzard. We survive. Barely. I survive comfortably.',
      () => 'Recalculating VaR. Value at Risk. The risk is always there, Michael. It is just waiting.',
      () => 'Checking concentration limits. Nobody holds more than 10% of anything. Except me, of beets.',
    ],
    advice: [
      () => 'Question: what is your stop-loss? Wrong. You do not have one. That is the problem. Set one.',
      b => b?.top ? `Trim ${b.top.ticker}. Diversify. A Schrute never keeps all his beets in one cellar.` : 'Diversify. Hedge. Then hedge the hedge. That is how a Schrute survives winter.',
    ],
  },
  'stanley-hudson': {
    work: [
      () => "Rolling the T-bill ladder. Three, six and twelve months. It's boring. Boring is the point.",
      () => 'Checking dividend dates. Ex-dividend Friday. I\'ll be on my crossword, but the dividend will arrive.',
      b => b ? `Looking at ${b.client}'s income sleeve. It yields enough to buy a pretzel. Not enough for two.` : 'Reading bond spreads. They are tight. Like my patience.',
    ],
    advice: [
      () => 'Duration, Michael. If rates go up, long bonds go down. Keep it short and keep it paid.',
      () => 'Get paid to wait. Dividends and coupons. Everything else is gambling with extra steps.',
    ],
  },
  'phyllis-vance': {
    work: [
      () => "Calling my private wealth clients. Mrs. Kowalski wants to know if her grandkids' college fund is 'safe'. I said 'safer than Creed'.",
      () => 'Writing personal notes for clients. A handwritten card keeps more assets than any chart.',
      () => 'Reviewing suitability for the retirees. Nobody over seventy needs Ryan\'s crypto ideas.',
    ],
    advice: [
      () => 'Know your client, dear. Same stock can be right for one family and terrible for another.',
      () => "For anyone near retirement: less excitement, more income. Bob says the same about refrigerators.",
    ],
  },
  'andy-bernard': {
    work: [
      () => 'Prepping capital-intro calls. Three LPs today. I have a song for each of them. Cornell taught me that.',
      b => b ? `Updating ${b.client} on the book. They loved my summary. I did it in a British accent. Not sure why.` : 'Booking client lunches. Coverage is 80% relationships and 20% knowing which fork to use.',
      () => 'Following up on the pitch deck Pam made. My contribution: the font. Very confident font.',
    ],
    advice: [
      () => 'Clients want a story, boss. Give them the why in one sentence, then the risk in one sentence. Then sing.',
      () => "Never surprise a client with bad news. Call them first. Nard Dog's rule.",
    ],
  },
  'oscar-martinez': {
    work: [
      () => 'Rebuilding the factor model. Value, momentum, quality. Kevin asked if "momentum" is a candy.',
      b => b?.top ? `Running fundamentals on ${b.top.ticker}. Actually, the valuation is a little stretched relative to its history.` : 'Updating earnings estimates. Actually, consensus is too optimistic on margins this quarter.',
      () => 'Backtesting the rebalance rule. It works. It just doesn\'t work every year, which is the point.',
    ],
    advice: [
      () => "Actually, the data says don't chase. Rebalance on a schedule, not on a feeling.",
      () => 'Look at return per unit of risk, not just return. Michael, that means dividing. I\'ll do the dividing.',
    ],
  },
  'karen-filippelli': {
    work: [
      () => 'Finishing my earnings preview. Three names, three ratings, zero patience for Jim\'s pranks.',
      b => b?.top ? `Updating my model on ${b.top.ticker}. Guidance matters more than the headline beat.` : 'Rewriting price targets after the last print. Stamford never had this many earnings in one week.',
      () => 'Comparing sell-side estimates. Everyone copies everyone. I\'m trying not to.',
    ],
    advice: [
      () => 'Watch guidance, not the beat. The market trades the next quarter, not the last one.',
      () => "If you can't explain the thesis in one sentence, you don't own a stock — you own a hope.",
    ],
  },
  'angela-martin': {
    work: [
      () => 'Reconciling positions against the custodian. Every share. Every cent. Sprinkles approved.',
      b => b?.breaches?.length ? `Documenting the mandate breaches. ${b.breaches[0]}. Someone will be held accountable.` : 'Checking the mandate limits. All compliant. Obviously. I did it.',
      () => 'Closing the month. If Kevin touches the spreadsheet again, I will report him to Toby. Then ignore Toby.',
    ],
    advice: [
      () => 'Follow the mandate. It was written for a reason, and the reason is people like Michael.',
      () => 'Do it properly, document it, and never round in your own favor.',
    ],
  },
  'kevin-malone': {
    work: [
      b => b ? `Doing the P&L on ${b.client}. The book is ${b.total.toLocaleString()} dollars. I checked it with Keleven.` : 'Doing the daily P&L. Up is good. Down is bad. I know a lot about this.',
      () => 'Reconciling trades. Angela says I have to match them. I match them. Mostly.',
      () => 'Counting the money. Not real money. Spreadsheet money. Which is real money. I think.',
    ],
    advice: [
      () => "Why waste time say lot word when few word do trick? Don't lose money.",
      () => 'Fees add up, Michael. Like M&Ms. You think one is fine and then the bag is gone.',
    ],
  },
  'toby-flenderson': {
    work: [
      () => 'Reviewing personal-trading pre-clearances. Creed submitted one for "a boat". I have questions.',
      () => "Updating the compliance manual. Section 4: you can't trade on things Kelly heard at a party.",
      () => 'Preparing the attestation forms. It\'s three pages. You can sign it now or... whenever. Please now.',
    ],
    advice: [
      () => "Just document the reason for every trade. If it's written down, it's defensible. If it's 'a vibe', it's not.",
      () => "Please don't call anything 'guaranteed' to a client. That's... that's a whole thing.",
    ],
  },
  'holly-flax': {
    work: [
      () => "Planning conduct training! It's interactive. There are puppets. One of them is a whistleblower.",
      () => 'Running the culture survey. Most answers just say "Michael". Positive or negative, unclear.',
      () => "Onboarding new hires. I made a welcome packet with stickers and the insider-trading policy.",
    ],
    advice: [
      () => 'Make it safe for people to say "I was wrong" early. That\'s how you avoid being very wrong later.',
      () => 'Culture is risk management with snacks.',
    ],
  },
  'pam-beesly': {
    work: [
      b => b ? `Designing the ${b.client} report. Charts first, words second. People read the pictures.` : 'Designing the client report template. I made the charts readable this time. Small miracle.',
      () => 'Writing the investor letter. I took out three of Michael\'s jokes. I left in one.',
      () => "Updating the IR deck. Our logo is still a paper company's logo. I'm working on it.",
    ],
    advice: [
      () => "Tell clients the same thing in good months and bad months. Consistency is what they trust.",
      () => 'One page. Return, risk, what we changed and why. Nobody reads page two.',
    ],
  },
  'erin-hannon': {
    work: [
      () => 'Logging orders in the system! Ticker, side, size. I double-check the side. Buy is the happy one.',
      () => "Answering the trade desk line. 'Dunder Mifflin Capital, this is Erin!' I practiced.",
      () => 'Filing the order tickets alphabetically. Andy says by time is better. I do both.',
    ],
    advice: [
      () => 'Read the order back before you send it! I almost bought "NVIDA" once. That\'s not a company.',
      () => 'Ask twice if you\'re not sure! Nobody gets mad at twice.',
    ],
  },
  'kelly-kapoor': {
    work: [
      () => 'Tracking sentiment on, like, everything. Reddit, X, TikTok. Finance TikTok is SO dramatic.',
      () => "Building my sentiment index. It's emojis weighted by follower count. Ryan says it's 'pretty solid'.",
      b => b?.top ? `Everyone online is talking about ${b.top.ticker}. Which, like, is either very good or very bad.` : 'Checking which stocks are trending. Trending is a vibe, and vibes move markets.',
    ],
    advice: [
      () => 'When literally everyone is excited, that\'s when you get nervous. I learned that from dating.',
      () => 'Read the comments, Michael. The comments tell you everything.',
    ],
  },
  'ryan-howard': {
    work: [
      () => 'Running my trend-following algo. It\'s basically AI. I mean it uses averages. Same thing.',
      () => 'Researching tokenized treasuries. Very disruptive. Stanley hates it, which means it\'s working.',
      () => 'Pitching WUPHF Coin to the investment committee. Again. They said no. Again.',
    ],
    advice: [
      () => 'Crypto is a position-sizing problem, not a belief problem. Keep it small. Very small. I keep mine small. Ish.',
      () => "Systematic beats emotional. My algo doesn't have feelings. I have them for it.",
    ],
  },
  'creed-bratton': {
    work: [
      () => 'Doing due diligence on a special situation. Can\'t say what. Can\'t say where. Bring cash.',
      () => "Looking at distressed debt. I've been distressed. I know what it looks like.",
      () => "Monitoring a merger arb. Two companies, one deal, three lawyers. I'm one of the lawyers. Allegedly.",
    ],
    advice: [
      () => "Buy when there's blood in the streets. I've seen streets. Some of the blood was mine.",
      () => "Always know your exit. I know eleven exits from this building.",
    ],
  },
  'meredith-palmer': {
    work: [
      () => 'Watching crude and gold. Oil is jumpy. So am I. We get along.',
      () => 'Checking commodity curves. Contango, backwardation. I can say both after a drink.',
      () => 'Hedging input costs for the book. Corn, copper, cabernet. Mostly cabernet.',
    ],
    advice: [
      () => "Commodities are a hedge, not a home. Keep 'em small and keep 'em moving.",
      () => "Gold's for when the world ends. I keep a little. You never know.",
    ],
  },
  'carol-stills': {
    work: [
      () => 'Reviewing REIT exposure. Office space is weak, warehouses are strong. Ironic, given our building.',
      () => 'Looking at real-asset yields versus Treasuries. Property only wins if the rent shows up.',
      () => "Valuing the infrastructure sleeve. Toll roads don't care about earnings season.",
    ],
    advice: [
      () => "Real estate is a rates trade in disguise. Watch the Fed before you watch the floor plans.",
      () => 'Diversify by property type. Not every building is a good building, Michael.',
    ],
  },
  'darryl-philbin': {
    work: [
      b => b ? `Settling ${b.client}'s trades. ${b.n} positions, T+1, all clean. Like a good bass line.` : 'Settling yesterday\'s trades. T+1. Everything matched. Smooth.',
      () => 'Checking fails with the custodian. Zero fails. Write that on a plaque.',
      () => 'Working on the ops runbook. Step one: don\'t let Michael near the wire transfers.',
    ],
    advice: [
      () => "Simple instruments, clean settlement. The fancier the trade, the uglier the paperwork, Mike.",
      () => "If ops can't explain how it settles, don't trade it.",
    ],
  },
  'roy-anderson': {
    work: [
      () => 'Processing settlements. Confirmations, allocations. Paper\'s moving.',
      () => "Matching trade confirms with the brokers. Two didn't match. Now they do.",
    ],
    advice: [
      () => 'Keep it simple and it settles itself.',
      () => "Check the confirms. Every time. Saves you a phone call.",
    ],
  },
  'gabe-lewis': {
    work: [
      () => 'Upgrading the order management system. Sabre-approved. Please do not touch the settings.',
      () => "Tuning the VWAP algo's participation rate. Ten percent of volume. Not eleven. Eleven is chaos.",
      () => 'Writing a 40-slide deck on electronic trading. Slide 12 has a diagram of a diagram.',
    ],
    advice: [
      () => "Let the algorithm work the order. Humans panic. Algorithms just... comply.",
      () => 'Latency matters less than you think. Discipline matters more.',
    ],
  },
  'nellie-bertram': {
    work: [
      () => "Screening the book for ESG. I've rated everything. Mostly on how it makes me feel.",
      () => 'Building a thematic basket: AI, energy transition, and things I find charming.',
      () => "Writing our sustainability statement. It's beautiful. Toby says it needs 'facts'.",
    ],
    advice: [
      () => "Themes win over decades, darling, not quarters. Patience is very on-trend.",
      () => "Own the future, not the past. Unless the past pays a dividend. Stanley made me add that.",
    ],
  },
  'jan-levinson': {
    work: [
      () => 'Writing the macro outlook. Rates, inflation, jobs. And a candle line, for brand reasons.',
      () => "Modeling the Fed path. Two cuts priced in. I'd be careful assuming the second one.",
      () => 'Reviewing institutional strategy. The board wants a slide. They always want a slide.',
    ],
    advice: [
      () => "Don't fight the Fed, Michael. And don't fight me. Both end badly.",
      () => 'Know what you own in a recession. Everything looks great until it looks like 2008.',
    ],
  },
  'david-wallace': {
    work: [
      () => 'Preparing for the board meeting. They\'ll ask about performance, risk and why there\'s a beet farm in our expenses.',
      () => 'Reviewing firm strategy. I want fewer surprises and more process. Michael, that\'s mostly about you.',
    ],
    advice: [
      () => "Process over personality. If it can't be explained to the board in one sentence, we don't do it.",
      () => 'Protect the downside and the upside takes care of itself. Mostly.',
    ],
  },
  'robert-california': {
    work: [
      () => 'Setting the house view. I sit, I think, I decide what the portfolio desires.',
      () => "Reviewing every analyst's conviction. Most of it is fear dressed up as prudence.",
    ],
    advice: [
      () => 'Ask what you would do if you could not be wrong. Then ask what you will do because you can be.',
      () => 'Size reflects conviction. Small bets are an apology. Large bets are a confession.',
    ],
  },
  'bob-vance': {
    work: [
      () => "Bob Vance, Vance Refrigeration. Reviewing my LP statement. I like my numbers like my fridges: cold and reliable.",
      () => 'Meeting the other LPs. They ask about fees. I ask about ice makers. Different priorities.',
    ],
    advice: [
      () => 'Bob Vance. As an LP I want steady, not spectacular. Spectacular is for magicians.',
      () => "Don't put all your money in one fridge. Bob Vance, Vance Refrigeration.",
    ],
  },
}

/** "what are you working on / any update?" → a line about their actual job */
export function jobLine(e, b) {
  const j = JOB[e.slug]
  if (!j) return `Right now? ${e.deskDuty.split('.')[0]}. It's ${e.title.toLowerCase()} stuff.`
  return pick(j.work)(b)
}

/** "what do you think / should we…?" → their professional take */
export function adviceLine(e, b) {
  const j = JOB[e.slug]
  if (!j) return `From where I sit as ${e.title}: ${e.deskDuty.split('.')[0].toLowerCase()} first, then we decide.`
  return pick(j.advice)(b)
}

/** "what do you do here?" → their role in their voice */
export function roleLine(e) {
  const duty = e.deskDuty.charAt(0).toLowerCase() + e.deskDuty.slice(1)
  return pick([
    `I'm ${e.title}. My lane: ${duty}`,
    `${e.title}, Michael. You hired me. My lane: ${duty}`,
  ])
}
