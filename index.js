const express = require('express');
const bodyParser = require('body-parser');
const { MongoClient } = require('mongodb');
const dotenv = require('dotenv');
const axios = require('axios');
const Twilio = require('twilio');
const cors = require('cors');


dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());


const uri = `mongodb+srv://${process.env.MONGODB_USER}:${process.env.MONGODB_PASSWORD}@cluster0.6hv3xgs.mongodb.net/ff-collections-agent?retryWrites=true&w=majority&appName=Cluster0`;
const clientDB = new MongoClient(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
});
let faqCollection;
let ticketsCollection;
let archivesCollection;
let activePhoneNumbers = [];
let replyText;


async function connectToDB() {
    await clientDB.connect();
    const db = clientDB.db("ff-collections-agent");
    faqCollection = db.collection("FF");
    ticketsCollection = db.collection("FF_Front_End_Tickets");
    archivesCollection = db.collection("FF_Front_End_Archives");
    await faqCollection.createIndex({ keywords: 'text', question: 'text', answer: 'text' });
}

connectToDB().catch(console.error);


const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioNumber = '+19519042811';
const twilioClient = new Twilio(accountSid, authToken);


const openaiApiKey = process.env.OPENAI_API_KEY;

function truncateAtSentence(text, maxLength) {
    if (text.length <= maxLength) return text;

    const sentenceEnd = /[\.\?\!](\s|$)/g;
    let lastValidIndex = -1;
    let match;

    while ((match = sentenceEnd.exec(text)) !== null) {
        if (match.index + 1 <= maxLength) {
            lastValidIndex = match.index + 1;
        } else {
            break;
        }
    }

    if (lastValidIndex === -1) {
        const lastSpaceIndex = text.lastIndexOf(' ', maxLength);
        if (lastSpaceIndex > 0) {
            lastValidIndex = lastSpaceIndex;
        } else {
            lastValidIndex = maxLength;
        }
    }

    return text.substring(0, lastValidIndex).trim();
}



function checkForHumanHelpNeeded(responseText) {
    const pattern = /unable to|cannot|can't|do not know|don't know|unsure|not sure|no information|not possible|impossible|help you with that/i;
    return pattern.test(responseText);
}


function normalizePhoneNumber(phoneNumber) {
    return phoneNumber.replace(/\D/g, '');
}

app.get('/serviceStatus', (req, res) => {
    const { phoneNumber } = req.query;
    if (phoneNumber) {
        const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber);
        const isActive = activePhoneNumbers.includes(normalizedPhoneNumber);
        console.log(`Checking status for ${normalizedPhoneNumber}: ${isActive}`);
        console.log('Active phone numbers:', JSON.stringify(activePhoneNumbers));
        res.json({ isActive });
    } else {
        res.status(400).json({ error: 'Phone number is required' });
    }
});

app.post('/toggleService', (req, res) => {
    const { phoneNumber, isActive } = req.body;

    if (phoneNumber && typeof isActive === 'boolean') {
        const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber);
        console.log(`Received request to set status for ${normalizedPhoneNumber} to ${isActive}`);

        if (isActive) {
            if (!activePhoneNumbers.includes(normalizedPhoneNumber)) {
                activePhoneNumbers.push(normalizedPhoneNumber);
                console.log(`Added ${normalizedPhoneNumber} to activePhoneNumbers`);
            } else {
                console.log(`${normalizedPhoneNumber} is already in the activePhoneNumbers list`);
            }
        } else {
            if (activePhoneNumbers.includes(normalizedPhoneNumber)) {
                activePhoneNumbers = activePhoneNumbers.filter(num => num !== normalizedPhoneNumber);
                console.log(`Removed ${normalizedPhoneNumber} from activePhoneNumbers`);
            } else {
                console.log(`${normalizedPhoneNumber} is not in the activePhoneNumbers list`);
            }
        }

        console.log('Updated active phone numbers:', JSON.stringify(activePhoneNumbers));
        res.status(200).json({ message: `Service for ${normalizedPhoneNumber} is now ${isActive}` });
    } else {
        res.status(400).json({ error: 'Invalid value. Please provide a phone number and a boolean value for isActive.' });
    }
});

async function findOrCreateConversation(phoneNumber) {
    const conversations = await twilioClient.conversations.v1.conversations.list();
    let conversation = conversations.find(conv => conv.friendlyName === phoneNumber);
    return conversation;
}

app.post('/sms', async (req, res) => {

    const incomingMsg = req.body.Body;
    const fromNumber = req.body.From;

    const normalizedFromNumber = normalizePhoneNumber(fromNumber);

    console.log(`Received message from ${normalizedFromNumber}: ${incomingMsg}`);

    if (!activePhoneNumbers.includes(normalizedFromNumber)) {

    try {

        const faqs = await faqCollection.find({ $text: { $search: incomingMsg } }).toArray();

        replyText = "";
        //let needsHumanHelp = false;

        if (faqs.length > 0) {
            let relevantFaqs = faqs.filter(faq => faq.score >= 0.5);
            if (relevantFaqs.length > 0) {
                replyText = relevantFaqs[0].answer;
                //needsHumanHelp = checkForHumanHelpNeeded(replyText);
            }
        }

        if (!replyText) {

            const allFaqContext = faqs.map(faq => `Q: ${faq.question} A: ${faq.answer}`).join('\n');
            const response = await axios.post("https://api.openai.com/v1/chat/completions", {
                model: "gpt-3.5-turbo",
                messages: [
                    { role: "system", content: "Provide a clear, concise, and informative response within 90 to 100 words and ensure the response ends at a complete sentence." },
                    { role: "system", content: allFaqContext },
                    { role: "user", content: incomingMsg }
                ],
                temperature: 0.1,
                max_tokens: 140
            }, {
                headers: { "Authorization": `Bearer ${openaiApiKey}`, "Content-Type": "application/json" },
                timeout: 60000
            });
            replyText = response.data.choices[0].message.content;
            //needsHumanHelp = checkForHumanHelpNeeded(replyText);
        }

        console.log(`Message sent to ${fromNumber}`);
        res.type('text/xml').send('<Response></Response>');
    } catch (error) {
        console.error('Failed to process request:', error);
        res.status(500).send('Failed to process your message.');
    }
    } else {
        console.log("Chatbot is inactive")
    }
});




async function participantExists(conversationSid, identity) {
    try {
        let participants = await twilioClient.conversations.v1.conversations(conversationSid).participants.list();
        return participants.some(participant => participant.identity === identity);
    } catch (error) {
        console.error(`Error checking participant existence: ${error.message}`);
        throw error;
    }
}

app.post('/webhook', async (req, res) => {
    let eventType = req.body.EventType;
    let conversationSid = req.body.ConversationSid;
    let participantSid = req.body.ParticipantSid;

    try {
        if (eventType === 'onParticipantAdded') {
            let phoneNumber = req.body["MessagingBinding.Address"];
            const normalizedFromNumber = normalizePhoneNumber(phoneNumber);
            await twilioClient.conversations.v1.conversations(conversationSid)
            .update({friendlyName: phoneNumber});
            if (!(await participantExists(conversationSid, 'tyler@proleadsmarketing.com'))) {
                await twilioClient.conversations.v1.conversations(conversationSid)
                    .participants
                    .create({ identity: 'tyler@proleadsmarketing.com', attributes: JSON.stringify({ name: 'tyler@proleadsmarketing.com' }) });
            }
            if (!(await participantExists(conversationSid, phoneNumber))) {
                await twilioClient.conversations.v1.conversations(conversationSid)
                    .participants
                    .create({ identity: phoneNumber, attributes: JSON.stringify({ name: phoneNumber }) });
            }
            if (!(await participantExists(conversationSid, twilioNumber))) {
                await twilioClient.conversations.v1.conversations(conversationSid)
                    .participants
                    .create({ identity: twilioNumber, attributes: JSON.stringify({ name: twilioNumber }) });
            }

        } else if (eventType === 'onMessageAdded') {
            let phoneNumber = req.body.Author;
            const normalizedFromNumber = normalizePhoneNumber(phoneNumber);
            const conversation = await twilioClient.conversations.v1.conversations(conversationSid).fetch();
            if (!conversation.friendlyName) {
            await twilioClient.conversations.v1.conversations(conversationSid)
            .update({friendlyName: phoneNumber});
            }
            if (!(await participantExists(conversationSid, 'tyler@proleadsmarketing.com'))) {
                await twilioClient.conversations.v1.conversations(conversationSid)
                    .participants
                    .create({ identity: 'tyler@proleadsmarketing.com', attributes: JSON.stringify({ name: 'tyler@proleadsmarketing.com' }) });
            }
            if (!(await participantExists(conversationSid, phoneNumber))) {
                await twilioClient.conversations.v1.conversations(conversationSid)
                    .participants
                    .create({ identity: phoneNumber, attributes: JSON.stringify({ name: phoneNumber }) });
            }
            if (!(await participantExists(conversationSid, twilioNumber))) {
                await twilioClient.conversations.v1.conversations(conversationSid)
                    .participants
                    .create({ identity: twilioNumber, attributes: JSON.stringify({ name: twilioNumber }) });
            }

            replyText = await truncateAtSentence(replyText, 100);
            if (phoneNumber === "tyler@proleadsmarketing.com") {
                console.log("Message from web, no reply will be sent.");
            } else if (!activePhoneNumbers.includes(normalizedFromNumber)) {
                setTimeout(async() => {
                    await twilioClient.conversations.v1.conversations(conversationSid)
                        .messages
                        .create({ body: replyText, author: twilioNumber });
                }, 3000);
                console.log(replyText);
            } else {
                console.log("Chatbot is inactive");
            }

            try {
                await archivesCollection.deleteOne({ conversationSID: conversationSid });
              } catch (err) {
                console.error(err);
                res.status(500).json({ message: 'An error occurred while restoring conversation', error: err.message });
              }
        }
        res.sendStatus(200);
    } catch (error) {
        console.error(`Webhook error: ${error.message}`);
        res.sendStatus(500);
    }
});



let PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});