/**
 * Seed script: Upload 40 MCQ questions + exam config to Firestore.
 *
 * Usage:
 *   1. npm install firebase-admin
 *   2. Download service account key from Firebase Console -> Project Settings -> Service Accounts
 *   3. Save as serviceAccountKey.json in this directory
 *   4. node seed-exam.js
 */

const admin = require('firebase-admin');

const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const questions = [
  { text: "What is the closest star to Earth?", options: ["Proxima Centauri", "Alpha Centauri A", "The Sun", "Barnard's Star"], correctAnswer: "C" },
  { text: "How long does it take for light from the Sun to reach Earth?", options: ["About 4 minutes", "About 8 minutes", "About 12 minutes", "About 15 minutes"], correctAnswer: "B" },
  { text: "Which planet is known as the Red Planet?", options: ["Venus", "Jupiter", "Mars", "Saturn"], correctAnswer: "C" },
  { text: "What is the largest planet in our solar system?", options: ["Saturn", "Neptune", "Jupiter", "Uranus"], correctAnswer: "C" },
  { text: "What is a galaxy?", options: ["A single star", "A system of stars, gas, and dust bound by gravity", "A planet's moon", "An asteroid belt"], correctAnswer: "B" },
  { text: "What is the name of our galaxy?", options: ["Andromeda", "Milky Way", "Triangulum", "Sombrero"], correctAnswer: "B" },
  { text: "What causes a solar eclipse?", options: ["The Moon passes between Earth and the Sun", "Earth passes between the Sun and the Moon", "The Sun passes between Earth and the Moon", "A planet crosses in front of the Sun"], correctAnswer: "A" },
  { text: "Which planet has the most moons?", options: ["Jupiter", "Saturn", "Uranus", "Neptune"], correctAnswer: "B" },
  { text: "What is a light-year?", options: ["The time light takes to travel from the Sun to Earth", "The distance light travels in one year", "The time it takes for a star to complete one orbit", "The brightness of a star"], correctAnswer: "B" },
  { text: "What type of celestial body is Halley's Comet?", options: ["Asteroid", "Meteor", "Comet", "Dwarf planet"], correctAnswer: "C" },
  { text: "Which planet is closest to the Sun?", options: ["Venus", "Mercury", "Earth", "Mars"], correctAnswer: "B" },
  { text: "What is the Great Red Spot on Jupiter?", options: ["A mountain", "A volcano", "A storm", "A crater"], correctAnswer: "C" },
  { text: "What force keeps planets in orbit around the Sun?", options: ["Magnetism", "Gravity", "Inertia", "Solar wind"], correctAnswer: "B" },
  { text: "Which of these is a dwarf planet?", options: ["Europa", "Titan", "Pluto", "Ganymede"], correctAnswer: "C" },
  { text: "What is the speed of light in a vacuum?", options: ["300,000 km/s", "150,000 km/s", "500,000 km/s", "1,000,000 km/s"], correctAnswer: "A" },
  { text: "Which planet is known for its prominent ring system?", options: ["Jupiter", "Uranus", "Neptune", "Saturn"], correctAnswer: "D" },
  { text: "What is the name of the first artificial satellite launched into space?", options: ["Explorer 1", "Sputnik 1", "Vanguard 1", "Apollo 11"], correctAnswer: "B" },
  { text: "What is the phenomenon where a star explodes at the end of its life cycle?", options: ["Nova", "Supernova", "Pulsar", "Black hole"], correctAnswer: "B" },
  { text: "Which planet rotates on its side?", options: ["Neptune", "Uranus", "Saturn", "Mars"], correctAnswer: "B" },
  { text: "What is the largest moon in the solar system?", options: ["Titan", "Europa", "Ganymede", "Callisto"], correctAnswer: "C" },
  { text: "What is the asteroid belt located between?", options: ["Earth and Mars", "Mars and Jupiter", "Jupiter and Saturn", "Saturn and Uranus"], correctAnswer: "B" },
  { text: "What type of star is the Sun classified as?", options: ["Red giant", "White dwarf", "Yellow dwarf", "Blue supergiant"], correctAnswer: "C" },
  { text: "What is the name of the brightest star in the night sky?", options: ["Polaris", "Sirius", "Betelgeuse", "Vega"], correctAnswer: "B" },
  { text: "What is the term for a group of stars forming a recognizable pattern?", options: ["Galaxy", "Cluster", "Constellation", "Nebula"], correctAnswer: "C" },
  { text: "Which Apollo mission first landed humans on the Moon?", options: ["Apollo 11", "Apollo 12", "Apollo 13", "Apollo 14"], correctAnswer: "A" },
  { text: "What is the name of the boundary around a black hole beyond which nothing can escape?", options: ["Event horizon", "Singularity", "Accretion disk", "Photon sphere"], correctAnswer: "A" },
  { text: "Which planet has the highest surface temperature?", options: ["Mercury", "Venus", "Mars", "Jupiter"], correctAnswer: "B" },
  { text: "What is the study of the universe called?", options: ["Astrology", "Cosmology", "Meteorology", "Geology"], correctAnswer: "B" },
  { text: "What is the name of the telescope that replaced the Hubble Space Telescope?", options: ["James Webb Space Telescope", "Kepler Space Telescope", "Chandra X-ray Observatory", "Spitzer Space Telescope"], correctAnswer: "A" },
  { text: "What causes the phases of the Moon?", options: ["Earth's shadow on the Moon", "The Moon's orbit around Earth", "The Sun's varying brightness", "Clouds in Earth's atmosphere"], correctAnswer: "B" },
  { text: "What is the name of the closest galaxy to the Milky Way?", options: ["Andromeda Galaxy", "Triangulum Galaxy", "Whirlpool Galaxy", "Sombrero Galaxy"], correctAnswer: "A" },
  { text: "Which element is most abundant in the universe?", options: ["Oxygen", "Carbon", "Hydrogen", "Helium"], correctAnswer: "C" },
  { text: "What is the name of the NASA rover that landed on Mars in 2021?", options: ["Curiosity", "Perseverance", "Opportunity", "Spirit"], correctAnswer: "B" },
  { text: "What is a nebula?", options: ["A type of star", "A cloud of gas and dust in space", "A small galaxy", "An asteroid"], correctAnswer: "B" },
  { text: "How many planets are in our solar system?", options: ["7", "8", "9", "10"], correctAnswer: "B" },
  { text: "What is the name of the phenomenon where light from distant galaxies is shifted to longer wavelengths?", options: ["Blue shift", "Red shift", "Doppler shift", "Gravitational lensing"], correctAnswer: "B" },
  { text: "Which planet has the strongest magnetic field?", options: ["Earth", "Jupiter", "Saturn", "Neptune"], correctAnswer: "B" },
  { text: "What is the name of the first human to walk in space?", options: ["Yuri Gagarin", "Neil Armstrong", "Alexei Leonov", "Buzz Aldrin"], correctAnswer: "C" },
  { text: "What is the cosmic microwave background radiation?", options: ["Heat from the Sun", "Afterglow of the Big Bang", "Light from distant stars", "Radiation from black holes"], correctAnswer: "B" },
  { text: "What is the approximate age of the universe?", options: ["4.6 billion years", "10 billion years", "13.8 billion years", "20 billion years"], correctAnswer: "C" },
];

async function seed() {
  const batch = db.batch();
  const examRef = db.collection('round1').doc('round1');

  batch.set(examRef, {
    title: 'GAAC Round 1 — Astronomy & Astrophysics',
    duration: 60,
    totalQuestions: questions.length,
    passingScore: 40,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  questions.forEach((q, i) => {
    const qRef = db.collection('round1').doc('round1').collection('questions').doc(`q${i + 1}`);
    batch.set(qRef, {
      text: q.text,
      options: q.options,
      order: i + 1
    });
    const aRef = db.collection('round1').doc('round1').collection('answerKeys').doc(`q${i + 1}`);
    batch.set(aRef, {
      correctAnswer: q.correctAnswer,
      order: i + 1
    });
  });

  await batch.commit();
  console.log(`Seeded ${questions.length} questions into round1/round1/questions`);
  process.exit(0);
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
