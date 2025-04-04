import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import connectDB, { TransactionModel, CategoryLimitModel, UserModel } from "./db.js";
import 'dotenv/config';

const app = express();
const SECRET_KEY = process.env.SECRET_KEY;
const refreshTokens = new Set();
const SALT_ROUNDS = 10; 

app.use(express.json());
app.use(cors({ origin: '*' }));

connectDB();

const authenticate = (req, res, next) => {
  const authHeader = req.header("Authorization");
  if (!authHeader) return res.status(401).json({ message: "Access denied. No token provided." });

  const token = authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ message: "Invalid token format." });

  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    res.status(400).json({ message: "Invalid token." });
  }
};

app.post("/signup", async (req, res) => {
  try {
    const { userId, password } = req.body;
    if (await UserModel.findOne({ userId })) {
      return res.status(400).json({ message: "User already exists" });
    }
    
    // Hash
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const newUser = new UserModel({ userId, password: hashedPassword });
    await newUser.save();

    const token = jwt.sign({ userId }, SECRET_KEY, { expiresIn: "3d" });
    res.status(201).json({ message: "User registered successfully", token });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ message: "Internal server error", error: err.message });
  }
});

app.post("/signin", async (req, res) => {
  try {
    const { userId, password } = req.body;
    const user = await UserModel.findOne({ userId });
    
    if (!user) return res.status(400).json({ message: "Invalid credentials" });
    
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) return res.status(400).json({ message: "Invalid credentials" });

    const token = jwt.sign({ userId }, SECRET_KEY, { expiresIn: "3d" });
    res.status(200).json({ message: "Signin successful", token });
  } catch (err) {
    console.error("Signin error:", err);
    res.status(500).json({ message: "Internal server error", error: err.message });
  }
});

app.post("/refresh-token", (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken || !refreshTokens.has(refreshToken)) {
    return res.status(403).json({ message: "Invalid refresh token" });
  }
  jwt.verify(refreshToken, SECRET_KEY, (err, user) => {
    if (err) return res.status(403).json({ message: "Invalid refresh token" });
    const accessToken = jwt.sign({ userId: user.userId }, SECRET_KEY, { expiresIn: "30d" });
    res.json({ accessToken });
  });
});

app.get("/get-category-limits", authenticate, async (req, res) => {
  try {
    const limits = await CategoryLimitModel.find({ userId: req.userId });
    res.json(limits);
  } catch (error) {
    console.error("Category limits error:", error);
    res.status(500).json({ message: "Internal server error", error: error.message });
  }
});

app.post("/get-category", authenticate, async (req, res) => {
  try {
    const { payee } = req.body;
    const userId = req.userId;
    
    if (!payee) return res.status(400).json({ error: "Payee is required" });

    const userTransaction = await TransactionModel.findOne({ payee, userId })
      .sort({ createdAt: -1 })
      .select("category");
    
    if (userTransaction) {
      return res.status(200).json({ category: userTransaction.category });
    }
    
    const globalTransaction = await TransactionModel.findOne({ payee })
      .sort({ createdAt: -1 })
      .select("category");

    return res.status(200).json({ category: globalTransaction ? globalTransaction.category : null });
  } catch (error) {
    console.error("Error fetching category:", error);
    res.status(500).json({ message: "Internal server error", error: error.message });
  }
});

app.post("/set-category-limit", authenticate, async (req, res) => {
  try {
    const userId = req.userId;
    const { limits } = req.body;

    console.log("Received Body:", req.body); 

    if (!Array.isArray(limits) || limits.length === 0) {
      return res.status(400).json({ message: "Invalid request format. 'limits' must be a non-empty array." });
    }

    for (const { category, limit } of limits) {
      if (typeof category !== "string" || isNaN(Number(limit)) || Number(limit) < 0) {
        return res.status(400).json({ message: "Invalid category or limit value." });
      }

      await CategoryLimitModel.findOneAndUpdate(
        { userId, category },
        { userId, category, limit: Number(limit) },
        { upsert: true, new: true }
      );
    }

    res.json({ message: "Category limits updated successfully." });
  } catch (error) {
    console.error("Error updating category limits:", error);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.get("/get-analytics", authenticate, async (req, res) => {
  try {
    const userId = req.userId;
    const { month, year } = req.query;
    
    // Default to current month
    const targetMonth = month !== undefined ? parseInt(month) : new Date().getMonth();
    const targetYear = year !== undefined ? parseInt(year) : new Date().getFullYear();

    const firstDay = new Date(targetYear, targetMonth, 1);
    const lastDay = new Date(targetYear, targetMonth + 1, 0);

    const transactions = await TransactionModel.find({
      userId,
      date: { $gte: firstDay, $lte: lastDay }
    });

    const categoryLimits = await CategoryLimitModel.find({ userId });

    let categorySummary = {};
    let total = 0;
    
    transactions.forEach((txn) => {
      if (!categorySummary[txn.category]) {
        categorySummary[txn.category] = 0;
      }
      categorySummary[txn.category] += txn.amount;
      total += txn.amount;
    });

    const response = categoryLimits.map((limit) => ({
      category: limit.category,
      limit: limit.limit,
      spent: categorySummary[limit.category] || 0, 
    }));

    res.json({ 
      success: true, 
      total, 
      transactions, 
      categorySummary: response 
    });
  } catch (error) {
    console.error("Error fetching transaction summary:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

app.post("/check-transaction", authenticate, async (req, res) => {
  try {
    const { category, amount, redirectUrl, payee, bypassLimitCheck } = req.body;
    const userId = req.userId;
    
    if (!category || !amount || !redirectUrl || !payee) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    let exceedsLimit = false;
    let limitDetails = {};
    
    // Check if transaction exceeds limit (regardless of bypassLimitCheck)
    const firstDayOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const userTransactions = await TransactionModel.find({ userId, category, date: { $gte: firstDayOfMonth } });
    const totalSpent = userTransactions.reduce((sum, txn) => sum + txn.amount, 0);
    const categoryLimit = await CategoryLimitModel.findOne({ userId, category });

    if (categoryLimit && totalSpent + amount > categoryLimit.limit) {
      exceedsLimit = true;
      limitDetails = {
        limit: categoryLimit.limit,
        spent: totalSpent,
        remaining: categoryLimit.limit - totalSpent,
        exceedAmount: amount - (categoryLimit.limit - totalSpent)
      };
      
      // If limits are exceeded and user hasn't confirmed, return 411
      if (!bypassLimitCheck) {
        return res.status(411).json({ 
          message: `Limit exceeded! You have ₹${categoryLimit.limit - totalSpent} left.`,
          details: limitDetails
        });
      }
    }

    // Save the transaction to the database (either within limits or user confirmed bypass)
    await new TransactionModel({ 
      userId, 
      category, 
      amount, 
      payee, 
      date: new Date(),
      exceededLimit: exceedsLimit 
    }).save();

    res.status(200).json({ 
      message: exceedsLimit && bypassLimitCheck 
        ? "Transaction saved despite exceeding limit" 
        : "Transaction successful", 
      redirect: redirectUrl 
    });
  } catch (err) {
    console.error("Transaction check error:", err);
    res.status(500).json({ message: "Internal server error", error: err.message });
  }
});

app.get("/get-guilt-message", authenticate, async (req, res) => {
  try {
    const { category } = req.query;
    
    
    const messages = {
      "Food": [
        "Is your stomach really worth all that money? 🍔 Your budget is crying!",
        "Ordering out again? Your wallet is getting thinner than your future savings! 🍕",
      ],
      "Shopping": [
        "Another impulse buy? Your closet is full but your wallet is empty! 👜",
        "That new item might feel good now, but your bank account is feeling the pain! 🛍️"
      ],
      "Entertainment": [
        "Fun today, regret tomorrow? Your entertainment budget is screaming for help! 🎬",
        "Living large today, but what about tomorrow's expenses? 🎮"
      ],
      // Add more categories and messages
      "default": [
        "Uh-oh! You've crossed your monthly cap! Your future self might regret this...",
        "Budget alert! This purchase will put you in the red. Think twice!"
      ]
    };
    
    // Get messages for the category or use default
    const categoryMessages = messages[category] || messages.default;
    
    // Return a random message from the array
    const randomMessage = categoryMessages[Math.floor(Math.random() * categoryMessages.length)];
    
    res.status(200).json({ message: randomMessage });
  } catch (err) {
    console.error("Error fetching guilt message:", err);
    res.status(500).json({ message: "Internal server error", error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));