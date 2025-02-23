import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import connectDB, { TransactionModel, CategoryLimitModel, UserModel } from "./db.js";
import 'dotenv/config';

const app = express();
const SECRET_KEY = process.env.SECRET_KEY || "secret123";
const refreshTokens = new Set();

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
    const newUser = new UserModel({ userId, password });
    await newUser.save();

    const token = jwt.sign({ userId }, SECRET_KEY, { expiresIn: "1h" });
    res.status(201).json({ message: "User registered successfully", token });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ message: "Internal server error", error: err.message });
  }
});

app.post("/signin", async (req, res) => {
  try {
    const { userId, password } = req.body;
    const user = await UserModel.findOne({ userId, password });
    if (!user) return res.status(400).json({ message: "Invalid credentials" });

    const token = jwt.sign({ userId }, SECRET_KEY, { expiresIn: "1h" });
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

    const currentDate = new Date();
    const firstDay = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
    const lastDay = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);

    const transactions = await db.query(
      "SELECT category, amount FROM transactions WHERE user_id = ? AND date >= ? AND date <= ?",
      [userId, firstDay, lastDay]
    );

    const categoryLimits = await db.query(
      "SELECT category, limit_amount FROM category_limits WHERE user_id = ?",
      [userId]
    );

    let categorySummary = {};
    transactions.forEach((txn) => {
      if (!categorySummary[txn.category]) {
        categorySummary[txn.category] = 0;
      }
      categorySummary[txn.category] += txn.amount;
    });

    let response = categoryLimits.map((limit) => ({
      category: limit.category,
      limit: limit.limit_amount,
      spent: categorySummary[limit.category] || 0, 
    }));

    res.json({ success: true, transactions, categorySummary: response });
  } catch (error) {
    console.error("Error fetching transaction summary:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});




app.post("/check-transaction", authenticate, async (req, res) => {
  try {
    const { category, amount, redirectUrl, payee } = req.body;
    const userId = req.userId;
    
    if (!category || !amount || !redirectUrl || !payee) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const firstDayOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const userTransactions = await TransactionModel.find({ userId, category, date: { $gte: firstDayOfMonth } });
    const totalSpent = userTransactions.reduce((sum, txn) => sum + txn.amount, 0);
    const categoryLimit = await CategoryLimitModel.findOne({ userId, category });

    if (categoryLimit && totalSpent + amount > categoryLimit.limit) {
      return res.status(411).json({ message: `Limit exceeded! You have ₹${categoryLimit.limit - totalSpent} left.` });
    }

    await new TransactionModel({ userId, category, amount, payee, date: new Date() }).save();

    res.status(200).json({ message: "Transaction successful", redirect: redirectUrl });
  } catch (err) {
    console.error("Transaction check error:", err);
    res.status(500).json({ message: "Internal server error", error: err.message });
  }
});


const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
