import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, runTransaction, serverTimestamp, collection, query, where, getDocs, increment, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDsYFFtEJ96yg0Rqw7EfCZFoiLIaeDk6zY",
  authDomain: "gaac-registration-2026.firebaseapp.com",
  projectId: "gaac-registration-2026",
  storageBucket: "gaac-registration-2026.firebasestorage.app",
  messagingSenderId: "542838311094",
  appId: "1:542838311094:web:6104e2ed0d1cafa976be17",
  measurementId: "G-CEB6Z0RF5E"
};

const ambassadorConfig = {
  apiKey: "AIzaSyBZP5nwK9-C5HOJK6JEkMK4vylH9vkoKss",
  authDomain: "gaac-ambassador.firebaseapp.com",
  projectId: "gaac-ambassador",
  storageBucket: "gaac-ambassador.firebasestorage.app",
  messagingSenderId: "863700343765",
  appId: "1:863700343765:web:444d6dccd503c8967ffb5c",
  measurementId: "G-0F3CBV292K"
};

let app, db, ambApp, ambDb, auth;
try {
  app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  auth = getAuth(app);
  ambApp = initializeApp(ambassadorConfig, 'ambassador');
  ambDb = getFirestore(ambApp);
} catch (e) {
  console.error("Firebase initialization failed:", e);
}

// Countries Array
const countries = [
  "Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Antigua and Barbuda", "Argentina", "Armenia", "Australia", "Austria", "Azerbaijan", "Bahamas", "Bahrain", "Bangladesh", "Barbados", "Belarus", "Belgium", "Belize", "Benin", "Bhutan", "Bolivia", "Bosnia and Herzegovina", "Botswana", "Brazil", "Brunei", "Bulgaria", "Burkina Faso", "Burundi", "Côte d'Ivoire", "Cabo Verde", "Cambodia", "Cameroon", "Canada", "Central African Republic", "Chad", "Chile", "China", "Colombia", "Comoros", "Congo", "Costa Rica", "Croatia", "Cuba", "Cyprus", "Czechia", "Denmark", "Djibouti", "Dominica", "Dominican Republic", "Ecuador", "Egypt", "El Salvador", "Equatorial Guinea", "Eritrea", "Estonia", "Eswatini", "Ethiopia", "Fiji", "Finland", "France", "Gabon", "Gambia", "Georgia", "Germany", "Ghana", "Greece", "Grenada", "Guatemala", "Guinea", "Guinea-Bissau", "Guyana", "Haiti", "Holy See", "Honduras", "Hungary", "Iceland", "India", "Indonesia", "Iran", "Iraq", "Ireland", "Israel", "Italy", "Jamaica", "Japan", "Jordan", "Kazakhstan", "Kenya", "Kiribati", "Kuwait", "Kyrgyzstan", "Laos", "Latvia", "Lebanon", "Lesotho", "Liberia", "Libya", "Liechtenstein", "Lithuania", "Luxembourg", "Madagascar", "Malawi", "Malaysia", "Maldives", "Mali", "Malta", "Marshall Islands", "Mauritania", "Mauritius", "Mexico", "Micronesia", "Moldova", "Monaco", "Mongolia", "Montenegro", "Morocco", "Mozambique", "Myanmar", "Namibia", "Nauru", "Nepal", "Netherlands", "New Zealand", "Nicaragua", "Niger", "Nigeria", "North Korea", "North Macedonia", "Norway", "Oman", "Pakistan", "Palau", "Palestine State", "Panama", "Papua New Guinea", "Paraguay", "Peru", "Philippines", "Poland", "Portugal", "Qatar", "Romania", "Russia", "Rwanda", "Saint Kitts and Nevis", "Saint Lucia", "Saint Vincent and the Grenadines", "Samoa", "San Marino", "Sao Tome and Principe", "Saudi Arabia", "Senegal", "Serbia", "Seychelles", "Sierra Leone", "Singapore", "Slovakia", "Slovenia", "Solomon Islands", "Somalia", "South Africa", "South Korea", "South Sudan", "Spain", "Sri Lanka", "Sudan", "Suriname", "Sweden", "Switzerland", "Syria", "Tajikistan", "Tanzania", "Thailand", "Timor-Leste", "Togo", "Tonga", "Trinidad and Tobago", "Tunisia", "Turkey", "Turkmenistan", "Tuvalu", "Uganda", "Ukraine", "United Arab Emirates", "United Kingdom", "United States", "Uruguay", "Uzbekistan", "Vanuatu", "Venezuela", "Vietnam", "Yemen", "Zambia", "Zimbabwe"
];

// Populate dropdowns
const dataList = document.getElementById('country-list');
if (dataList) {
  countries.forEach(country => {
    const option = document.createElement('option');
    option.value = country;
    dataList.appendChild(option);
  });
}

// Toggle Member Sections
const btnAddMember2 = document.getElementById('btn-add-member-2');
const btnRemoveMember2 = document.getElementById('btn-remove-member-2');
const sectionMember2 = document.getElementById('section-member-2');
const btnAddMember3 = document.getElementById('btn-add-member-3');
const btnRemoveMember3 = document.getElementById('btn-remove-member-3');
const sectionMember3 = document.getElementById('section-member-3');

const toggleMemberSection = (sectionNum, show) => {
  const section = sectionNum === 2 ? sectionMember2 : sectionMember3;
  const addBtn = sectionNum === 2 ? btnAddMember2 : btnAddMember3;
  
  // Fields to toggle required status
  const fields = ['Name', 'Email', 'Country', 'School', 'Dob', 'Grade'].map(f => `member${sectionNum}${f}`);
  const els = fields.map(f => document.getElementById(f));
  
  if (show) {
    section.classList.remove('hidden');
    addBtn.classList.add('hidden');
    els.forEach(el => { if(el) el.required = true; });
    
    if (sectionNum === 2) {
      btnAddMember3.classList.remove('hidden'); // Show add member 3 button
    }
  } else {
    section.classList.add('hidden');
    addBtn.classList.remove('hidden');
    els.forEach(el => { 
      if(el) {
        el.required = false; 
        el.value = ''; // Clear values when hidden
      }
    });
    
    // If hiding member 2, also hide member 3
    if (sectionNum === 2) {
      toggleMemberSection(3, false);
      btnAddMember3.classList.add('hidden');
    }
  }
};

if (btnAddMember2) btnAddMember2.addEventListener('click', () => toggleMemberSection(2, true));
if (btnRemoveMember2) btnRemoveMember2.addEventListener('click', () => toggleMemberSection(2, false));
if (btnAddMember3) btnAddMember3.addEventListener('click', () => toggleMemberSection(3, true));
if (btnRemoveMember3) btnRemoveMember3.addEventListener('click', () => toggleMemberSection(3, false));

// Referral Logic
const urlParams = new URLSearchParams(window.location.search);
const referralCode = urlParams.get('ref');
let validAmbassadorId = null;

if (referralCode && ambDb) {
  console.log('[referral] Found ref in URL:', referralCode);
  (async () => {
    try {
      const q = query(collection(ambDb, 'ambassadors'), where('referralCode', '==', referralCode));
      const querySnapshot = await getDocs(q);
      console.log('[referral] Query returned:', querySnapshot.size, 'docs');
      if (!querySnapshot.empty) {
        validAmbassadorId = querySnapshot.docs[0].id;
        console.log('[referral] Valid! Ambassador ID:', validAmbassadorId);
      } else {
        console.warn('[referral] No ambassador found with code:', referralCode);
      }
    } catch (e) {
      console.error('[referral] Error validating referral code:', e);
    }
  })();
} else {
  console.warn('[referral] Skipped — referralCode:', referralCode, 'ambDb:', !!ambDb);
}

// Form Submission
const form = document.getElementById('gaac-registration-form');
const submitBtn = document.getElementById('submit-btn');
const btnText = submitBtn.querySelector('.btn-text');
const btnLoader = submitBtn.querySelector('.btn-loader');
const formAlert = document.getElementById('form-alert');
const registrationContainer = document.getElementById('registration-container');
const gaacRegistrationForm = document.getElementById('gaac-registration-form');
const successState = document.getElementById('success-state');


const generatePassword = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()';
  const lenArr = new Uint32Array(1);
  crypto.getRandomValues(lenArr);
  const length = 12 + (lenArr[0] % 5);
  const arr = new Uint32Array(length);
  crypto.getRandomValues(arr);
  let pw = '';
  for (let i = 0; i < length; i++) pw += chars[arr[i] % chars.length];
  return pw;
};

const showAlert = (msg, isError = true) => {
  formAlert.textContent = msg;
  formAlert.className = `form-alert ${isError ? 'error' : 'success'}`;
  formAlert.classList.remove('hidden');
};

const hideAlert = () => {
  formAlert.classList.add('hidden');
};

const setLoading = (isLoading) => {
  submitBtn.disabled = isLoading;
  if (isLoading) {
    btnText.classList.add('hidden');
    btnLoader.classList.remove('hidden');
  } else {
    btnText.classList.remove('hidden');
    btnLoader.classList.add('hidden');
  }
};

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAlert();
  
  // Clear previous field errors
  document.querySelectorAll('.error-msg').forEach(el => el.textContent = '');
  document.querySelectorAll('.error').forEach(el => el.classList.remove('error'));

  // Custom HTML5 validation display
  let isFormValid = true;
  Array.from(form.elements).forEach(el => {
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT') {
      if (!el.checkValidity()) {
        isFormValid = false;
        el.classList.add('error');
        const errorSpan = document.getElementById(`error-${el.id}`);
        if (errorSpan) {
          if (el.validity.valueMissing) {
            errorSpan.textContent = 'This is a required question';
          } else if (el.validity.patternMismatch) {
            errorSpan.textContent = el.title || 'Invalid format';
          } else if (el.validity.typeMismatch) {
            errorSpan.textContent = 'Invalid format';
          } else {
            errorSpan.textContent = el.validationMessage;
          }
        }
      }
    }
  });

  if (!isFormValid) {
    showAlert("Please fix the errors in the form before submitting.");
    // Scroll to the first error
    const firstError = document.querySelector('.error');
    if (firstError) firstError.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  // Extract and sanitize data
  const data = new FormData(form);
  const teamName = data.get('teamName').trim();
  const lowerTeamName = teamName.toLowerCase().replace(/[/\\]/g, '-');
  
  const getMemberData = (prefix) => {
    const name = (data.get(`${prefix}Name`) || '').trim();
    if (!name) return null; // not filled
    return {
      name,
      email: (data.get(`${prefix}Email`) || '').trim().toLowerCase(),
      country: data.get(`${prefix}Country`),
      school: (data.get(`${prefix}School`) || '').trim(),
      dob: data.get(`${prefix}Dob`),
      grade: data.get(`${prefix}Grade`)
    };
  };

  const leader = getMemberData('leader');
  const member2 = !sectionMember2.classList.contains('hidden') ? getMemberData('member2') : null;
  const member3 = !sectionMember3.classList.contains('hidden') ? getMemberData('member3') : null;

  // Check duplicate emails within the form
  const emails = [leader.email];
  if (member2) emails.push(member2.email);
  if (member3) emails.push(member3.email);

  const uniqueEmails = new Set(emails);
  if (uniqueEmails.size !== emails.length) {
    showAlert("Duplicate emails found within the team. Each member must have a unique email.");
    return;
  }

  setLoading(true);

  try {
    if (!db) {
      throw new Error("Firebase is not configured. Please add your config to registration.js.");
    }

    // Check if registration is open
    const compSnap = await getDoc(doc(db, 'settings', 'competition'));
    if (compSnap.exists()) {
      const compData = compSnap.data();
      if (compData.registrationOpen === false) {
        throw new Error('Registration is currently closed. Please check back later.');
      }
    }

    const loginPassword = generatePassword();

    const registrationId = await runTransaction(db, async (transaction) => {
      // 1. Check Team Name uniqueness
      const teamRef = doc(db, 'registeredTeams', lowerTeamName);
      const teamSnap = await transaction.get(teamRef);
      if (teamSnap.exists()) {
        throw new Error(`The team name "${teamName}" is already taken.`);
      }

      // 2. Check Emails uniqueness
      for (const email of emails) {
        const emailRef = doc(db, 'registeredEmails', email);
        const emailSnap = await transaction.get(emailRef);
        if (emailSnap.exists()) {
          throw new Error(`The email address "${email}" is already registered.`);
        }
      }

      // 3. Generate Sequential ID
      const counterRef = doc(db, 'settings', 'counter');
      const counterSnap = await transaction.get(counterRef);
      
      let newIdNum = 1;
      if (counterSnap.exists()) {
        newIdNum = counterSnap.data().lastId + 1;
      }
      
      const regId = `GAAC-2026-${String(newIdNum).padStart(4, '0')}`;
      const regRef = doc(db, 'registrations', regId);

      // 4. Perform Writes
      // Note: Must ensure security rules allow creating the counter if it doesn't exist
      transaction.set(counterRef, { lastId: newIdNum });
      
      transaction.set(teamRef, { 
        originalName: teamName, 
        registrationId: regId, 
        createdAt: serverTimestamp() 
      });

      emails.forEach((email) => {
        const emailRef = doc(db, 'registeredEmails', email);
        transaction.set(emailRef, { 
          teamName: teamName, 
          registrationId: regId,
          password: loginPassword
        });
      });

      const registrationData = {
        registrationId: regId,
        teamName,
        leader,
        password: loginPassword,
        timestamp: serverTimestamp(),
        status: 'registered'
      };

      if (member2) registrationData.member2 = member2;
      if (member3) registrationData.member3 = member3;

      if (validAmbassadorId) {
        registrationData.referredBy = validAmbassadorId;
        registrationData.referralCode = referralCode;
      }

      transaction.set(regRef, registrationData);

      // Add mail payload for Trigger Email extension
      const mailRef = doc(db, 'mail', regId);
      transaction.set(mailRef, {
        to: leader.email,
        message: {
          subject: 'GAAC 2026 Registration Confirmed — Team ' + teamName,
          html: `
            <!DOCTYPE html>
            <html>
            <head><meta charset="utf-8"></head>
            <body style="margin:0;padding:0;background:#0a0e17;font-family:'Inter',Arial,sans-serif;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0e17;padding:40px 20px;">
                <tr><td align="center">
                  <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;">
                    <tr><td align="center" style="padding-bottom:32px;">
                      <img src="https://gaac-registration-2026.web.app/GAAC_Final_logo_without_BG-removebg-preview.png" alt="GAAC" width="180" style="display:block;">
                    </td></tr>
                    <tr><td style="background:linear-gradient(135deg,rgba(255,255,255,0.07),rgba(255,255,255,0.018));border:1px solid rgba(38,183,255,0.15);border-radius:16px;padding:40px 36px;backdrop-filter:blur(22px);">
                      <h1 style="margin:0 0 8px;font-family:'Orbitron',Arial,sans-serif;font-size:1.3rem;font-weight:700;color:#ffffff;letter-spacing:0.04em;text-align:center;">Registration Confirmed</h1>
                      <p style="margin:0 0 6px;color:#aec8e0;font-size:0.88rem;text-align:center;">Global Astronomy &amp; Astrophysics Challenge 2026</p>
                      <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(38,183,255,0.3),transparent);margin:28px 0;"></div>
                      <p style="color:#e8f0f8;font-size:0.95rem;line-height:1.7;margin:0 0 6px;">Dear ${leader.name},</p>
                      <p style="color:#aec8e0;font-size:0.9rem;line-height:1.7;margin:0 0 20px;">Your team <strong style="color:#e8f0f8;">${teamName}</strong> has been successfully registered for GAAC 2026.</p>
                      <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(8,120,255,0.08);border:1px solid rgba(38,183,255,0.12);border-radius:12px;padding:20px;margin-bottom:24px;">
                        <tr><td style="padding-bottom:8px;color:#7a9bb5;font-size:0.75rem;letter-spacing:0.06em;text-transform:uppercase;">Registration ID</td></tr>
                        <tr><td style="font-family:'Orbitron',Arial,sans-serif;font-size:1.1rem;font-weight:700;color:#26b7ff;letter-spacing:0.08em;">${regId}</td></tr>
                        <tr><td style="padding:12px 0 8px;color:#7a9bb5;font-size:0.75rem;letter-spacing:0.06em;text-transform:uppercase;">Exam Portal Password</td></tr>
                        <tr><td style="font-family:'Orbitron',Arial,sans-serif;font-size:0.95rem;font-weight:600;color:#e8f0f8;letter-spacing:0.04em;">${loginPassword}</td></tr>
                      </table>
                      <table width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                          <td width="50%" style="padding-right:8px;padding-bottom:12px;">
                            <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(255,255,255,0.03);border-radius:8px;padding:12px;">
                              <tr><td style="color:#7a9bb5;font-size:0.7rem;letter-spacing:0.05em;text-transform:uppercase;padding-bottom:4px;">Team Leader</td></tr>
                              <tr><td style="color:#e8f0f8;font-size:0.85rem;font-weight:600;">${leader.name}</td></tr>
                              <tr><td style="color:#7a9bb5;font-size:0.78rem;">${leader.email}</td></tr>
                            </table>
                          </td>
                          <td width="50%" style="padding-left:8px;padding-bottom:12px;">
                            <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(255,255,255,0.03);border-radius:8px;padding:12px;">
                              <tr><td style="color:#7a9bb5;font-size:0.7rem;letter-spacing:0.05em;text-transform:uppercase;padding-bottom:4px;">Competition Date</td></tr>
                              <tr><td style="color:#e8f0f8;font-size:0.85rem;font-weight:600;">Coming Soon</td></tr>
                              <tr><td style="color:#7a9bb5;font-size:0.78rem;">Stay tuned for updates</td></tr>
                            </table>
                          </td>
                        </tr>
                      </table>
                      <div style="height:1px;background:linear-gradient(90deg,transparent,rgba(38,183,255,0.15),transparent);margin:20px 0 24px;"></div>
                      <p style="color:#aec8e0;font-size:0.85rem;line-height:1.6;margin:0 0 4px;">Keep this email for your records. Use your Registration ID and the password above to log in at the Exam Portal.</p>
                      <p style="color:#7a9bb5;font-size:0.82rem;line-height:1.5;margin:0;">If you have any questions, contact us at <a href="mailto:gaac@stemastronomyclub.org" style="color:#26b7ff;text-decoration:none;">gaac@stemastronomyclub.org</a></p>
                    </td></tr>
                    <tr><td align="center" style="padding-top:28px;">
                      <p style="color:#4a6a80;font-size:0.75rem;margin:0;">STEM Astronomy Club — Global Astronomy &amp; Astrophysics Challenge</p>
                    </td></tr>
                  </table>
                </td></tr>
              </table>
            </body>
            </html>
          `
        }
      });

      return regId;
    });

    // Create Firebase Auth accounts for all team members
    const memberEmails = [leader.email];
    if (member2) memberEmails.push(member2.email);
    if (member3) memberEmails.push(member3.email);
    for (const email of memberEmails) {
      try {
        const cred = await createUserWithEmailAndPassword(auth, email, loginPassword);
        await setDoc(doc(db, 'teamMembers', cred.user.uid), {
          teamId: registrationId,
          email: email,
          createdAt: serverTimestamp()
        });
      } catch (authError) {
        console.error(`Auth account creation failed for ${email}:`, authError);
      }
    }

    // Success! Show success state
    gaacRegistrationForm.classList.add('hidden');
    successState.classList.remove('hidden');

    // Award ambassador points — write to registration project's ambassadorPoints collection
    if (validAmbassadorId) {
      try {
        await setDoc(doc(db, 'ambassadorPoints', validAmbassadorId), {
          points: increment(10),
          successfulRegistrations: increment(1)
        }, { merge: true });
      } catch (e) {
        console.error("Failed to award ambassador points:", e);
      }
    }
    
  } catch (error) {
    console.error("Registration Error:", error);
    showAlert(error.message || "An error occurred during registration. Please try again.");
  } finally {
    setLoading(false);
  }
});
