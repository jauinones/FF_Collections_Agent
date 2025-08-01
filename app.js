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


const uri = `mongodb+srv://${process.env.MONGODB_USER}:${process.env.MONGODB_PASSWORD}@bedrockdev.j1dmahl.mongodb.net/test`;
const clientDB = new MongoClient(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
});
let faqCollection;
let ticketsCollection;
let activePhoneNumbers = [];


async function connectToDB() {
    await clientDB.connect();
    const db = clientDB.db("HRMAI");
    faqCollection = db.collection("Knowledge_Base");
    ticketsCollection = db.collection("Front_End_Tickets");
    await faqCollection.createIndex({ keywords: 'text', question: 'text', answer: 'text' });
    console.log("Connected to MongoDB and text indexes created");
}

connectToDB().catch(console.error);


const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;
const twilioClient = new Twilio(accountSid, authToken);


const openaiApiKey = process.env.OPENAI_API_KEY;

function truncateAtSentence(text, maxLength) {
    const sentenceEnd = /[\.\?\!](\s|$)/g;
    let lastValidIndex = -1;
    let match;

    while ((match = sentenceEnd.exec(text)) !== null) {
        if (match.index <= maxLength) {
            lastValidIndex = match.index + 1;
        } else {
            break;
        }
    }

    return lastValidIndex > -1 ? text.substring(0, lastValidIndex) : text.substring(0, maxLength);
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

app.post('/sms', async (req, res) => {

    const incomingMsg = req.body.Body;
    const fromNumber = req.body.From;

    const normalizedFromNumber = normalizePhoneNumber(fromNumber);

    console.log(`Received message from ${normalizedFromNumber}: ${incomingMsg}`);


    if (!activePhoneNumbers.includes(normalizedFromNumber)) {

    try {

        const faqs = await faqCollection.find({ $text: { $search: incomingMsg } }).toArray();

        let replyText = "";
        let needsHumanHelp = false;

        if (faqs.length > 0) {
            let relevantFaqs = faqs.filter(faq => faq.score >= 0.5);
            if (relevantFaqs.length > 0) {
                replyText = relevantFaqs[0].answer;
                needsHumanHelp = checkForHumanHelpNeeded(replyText);
            }
        }

        if (!replyText) {

            const allFaqContext = faqs.map(faq => `Q: ${faq.question} A: ${faq.answer}`).join('\n');
            const response = await axios.post("https://api.openai.com/v1/chat/completions", {
                model: "gpt-3.5-turbo",
                messages: [{ role: "system", content: allFaqContext }, { role: "user", content: incomingMsg }],
                temperature: 0.1,
                max_tokens: 100
            }, {
                headers: { "Authorization": `Bearer ${openaiApiKey}`, "Content-Type": "application/json" },
                timeout: 60000
            });
            replyText = response.data.choices[0].message.content;
            needsHumanHelp = checkForHumanHelpNeeded(replyText);
        }
        replyText = await truncateAtSentence(replyText, 700);
        console.log(replyText)
        console.log(`needsHumanHelp ${needsHumanHelp}`);
        await twilioClient.messages.create({
            to: fromNumber,
            from: twilioNumber,
            body: replyText
        });

        if (needsHumanHelp) {
            await ticketsCollection.insertOne({
                question: incomingMsg,
                answer: replyText,
                fromNumber: fromNumber,
                dateCreated: new Date(),
                open: true
            });
            console.log(`Tickets created`);
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


app.post('/webhook', async (req, res) => {
    const eventType = req.body.EventType;
    const conversationSid = req.body.ConversationSid;
    const participantSid = req.body.ParticipantSid;

    console.log(`Webhook received: ${JSON.stringify(req.body)}`);

    try {
        if (eventType === 'onParticipantAdded') {
            const phoneNumber = req.body["MessagingBinding.Address"];
            console.log(`Updating participant ${participantSid} in conversation ${conversationSid}`);

            const updatedParticipant = await twilioClient.conversations.v1.conversations(conversationSid)
                .participants(participantSid)
                .update({ friendlyName: phoneNumber });
            console.log(`Updated Participant: ${updatedParticipant.sid}`);

            const newParticipant = await twilioClient.conversations.v1.conversations(conversationSid)
                .participants
                .create({ identity: 'rafiulhasan86@gmail.com', friendlyName: "Rafiul Hasan" });
            console.log(`New Participant: ${newParticipant.sid}`);
        } else if (eventType === 'onMessageAdded') {
            const phoneNumber = req.body.Author
            console.log(`Updating participant ${participantSid} in conversation ${conversationSid}`);

            const updatedParticipant = await twilioClient.conversations.v1.conversations(conversationSid)
                .participants(participantSid)
                .update({ friendlyName: phoneNumber });
            console.log(`Updated Participant: ${updatedParticipant.sid}`);

            const newParticipant = await twilioClient.conversations.v1.conversations(conversationSid)
                .participants
                .create({ identity: 'rafiulhasan86@gmail.com', friendlyName: "Rafiul Hasan" });
            console.log(`New Participant: ${newParticipant.sid}`);
        }

        res.sendStatus(200);
    } catch (error) {
        console.error(`Webhook error: ${error.message}`);
        res.sendStatus(500);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});