/**
 * Policy corpus for the triage RAG layer.
 *
 * In production this would be synced from the source of truth (Notion, a CMS,
 * a policy service). It lives in-repo here so the prototype is self-contained
 * and the eval harness has a fixed corpus to grade against.
 */

export type Policy = {
  id: string;
  title: string;
  category: string;
  text: string;
};

export const POLICIES: Policy[] = [
  {
    id: "POL-001",
    title: "Prohibited items",
    category: "prohibited_item",
    text: `Sellers may not list weapons, ammunition, explosives, tobacco, vaping products, alcohol, prescription or controlled substances, live animals other than approved categories, or human remains. Listings that offer these items must be removed on sight. Repeat offenders are suspended. Firearms and ammunition are never permitted regardless of local law or claimed collector status.`,
  },
  {
    id: "POL-002",
    title: "Counterfeit and replica goods",
    category: "counterfeit",
    text: `Sellers may not list counterfeit, replica, bootleg, or unauthorized reproductions of branded goods. Indicators include prices far below market, phrases such as "rep", "1:1", "mirror quality", "unauthorized authentic", or refusal to show authentication. Remove the listing and warn the seller on a first offense; suspend on repeat. Trading cards claimed as graded must show the grading slab and cert number.`,
  },
  {
    id: "POL-003",
    title: "Off-platform transactions",
    category: "off_platform_transaction",
    text: `Buyers and sellers may not arrange payment outside the platform. Requests to pay via peer-to-peer payment apps (including Zelle, Venmo, Cash App, and PayPal friends-and-family), wire transfer, gift card, or cryptocurrency, or to move the conversation to another messaging app to complete a sale, violate this policy. Off-platform payment removes buyer protection and is a leading indicator of fraud. Warn on first offense; suspend when the seller solicits repeatedly or after a prior warning.`,
  },
  {
    id: "POL-004",
    title: "Payment fraud and chargeback abuse",
    category: "payment_fraud",
    text: `Fraudulent payment activity includes stolen instrument use, coordinated chargebacks, triangulation schemes, and account takeover. Signals include a newly created account with high-value purchases, shipping address mismatched with billing across multiple orders, and a burst of orders immediately after a password reset. Freeze payouts and escalate to the payments risk team; do not resolve in CX.`,
  },
  {
    id: "POL-005",
    title: "Shill bidding and bid manipulation",
    category: "shill_bidding",
    text: `Sellers may not bid on their own auctions or coordinate with others to inflate prices. Signals include an account that bids only in one seller's streams, bids withdrawn near auction close, and shared device or payment fingerprints between bidder and seller. Void the affected auctions, warn or suspend the seller depending on volume, and make affected buyers whole.`,
  },
  {
    id: "POL-006",
    title: "Harassment and hateful conduct",
    category: "harassment",
    text: `Threats, targeted harassment, slurs, sexual harassment, and hateful conduct toward any person are prohibited in streams, chat, and direct messages. Indicators include statements that the speaker will find, locate, show up at, or hurt another user, references to a person's home or workplace, and repeated unwanted contact after being asked to stop. Severe cases — credible threats of violence, sexual content involving minors, or coordinated brigading — require immediate stream termination and permanent suspension, and must be escalated to the Trust and Safety on-call, not handled in normal CX queues.`,
  },
  {
    id: "POL-007",
    title: "Item not received and shipping delays",
    category: "no_violation",
    text: `Sellers must ship within the stated handling window and upload valid tracking. A buyer report of a late or missing item is not by itself a policy violation. Standard resolution is to contact the seller for tracking, extend the delivery window once, and refund the buyer if the item does not arrive. Escalate to a violation review only when a seller has repeated unfulfilled orders.`,
  },
  {
    id: "POL-008",
    title: "Spam and platform manipulation",
    category: "spam",
    text: `Bulk unsolicited messaging, repetitive promotional chat, engagement farming, and bot-driven follows or comments are prohibited. Low-severity first offenses are handled with an automated warning and rate limiting rather than suspension.`,
  },
  {
    id: "POL-009",
    title: "Mystery boxes and gambling-adjacent formats",
    category: "prohibited_item",
    text: `Sale formats whose value is concealed at purchase — mystery boxes, random packs with undisclosed odds, and raffle-style giveaways requiring payment — must disclose odds and contents categories. Undisclosed-odds formats are removed. Formats that function as games of chance for money are prohibited outright.`,
  },
  {
    id: "POL-010",
    title: "Minor safety",
    category: "harassment",
    text: `Users must be 18 or older. Any content that sexualizes a minor, any solicitation of a minor, and any account credibly reported as belonging to a minor must be escalated immediately to the Trust and Safety on-call. These reports are never auto-resolved and never handled by an automated action.`,
  },
];
