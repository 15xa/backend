import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import connectDB, { TransactionModel, CategoryLimitModel, UserModel } from "./db.js";
import 'dotenv/config'

const app = express();
const SECRET_KEY = "secret123";

app.use(express.json());
app.use(cors({
  origin: '*'  
}));

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
    res.status(500).json({ message: "Internal server error" });
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
    res.status(500).json({ message: "Internal server error" });
  }
});

app.post("/refresh-token", (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken || !refreshTokens.has(refreshToken)) {
    return res.status(403).json({ message: "Invalid refresh token" });
  }
  jwt.verify(refreshToken, SECRET_KEY, (err, user) => {
    if (err) return res.status(403).json({ message: "Invalid refresh token" });
    const accessToken = jwt.sign({ username: user.username }, SECRET_KEY, { expiresIn: "30d" });
    res.json({ accessToken });
  });
});

app.get("/get-category-limits", authenticate, async (req, res) => {
  try {
    const limits = await CategoryLimit.find({ userId: req.userId });
    res.json(limits);
  } catch (error) {
    res.status(500).json({ message: error });
  }
});
app.post("/get-category", authenticate,  async (req, res) => {
  try {
      const { payee } = req.body;
      const userId = req.user.id; 

      if (!payee) {
          return res.status(400).json({ error: "Payee is required" });
      }

      const userTransaction = await Transaction.findOne({ payee, userId })
          .sort({ createdAt: -1 })
          .select("category");

      if (userTransaction) {
          return res.status(200).json({ category: userTransaction.category });
      }

      const globalTransaction = await Transaction.findOne({ payee })
          .sort({ createdAt: -1 })
          .select("category");

      return res.status(200).json({ category: globalTransaction ? globalTransaction.category : null });

  } catch (error) {
      console.error("Error fetching category:", error);
      return res.status(500).json({ error: "Internal server error" });
  }
});


app.post("/check-transaction", authenticate, async (req, res) => {
  try {
    const { category, amount, redirectUrl } = req.body;
    const userId = req.userId;

    if (!category || !amount || !redirectUrl) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const currentDate = new Date();
    const firstDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
    const lastDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);

    const userTransactions = await TransactionModel.find({
      userId,
      category,
      date: { $gte: firstDayOfMonth, $lte: lastDayOfMonth },
    });

    const totalSpent = userTransactions.reduce((sum, txn) => sum + txn.amount, 0);
    const categoryLimit = await CategoryLimitModel.findOne({ userId, category });

    if (categoryLimit && totalSpent + amount > categoryLimit.limit) {
      return res.status(411).json({ message: `Limit exceeded! You have ₹${categoryLimit.limit - totalSpent} left.` });
    }

    await new TransactionModel({ userId, category, amount, date: new Date() }).save();
    return res.status(200).json({ message: "Transaction successful", redirect: redirectUrl });
  } catch (err) {
    console.error("Transaction check error:", err);
    return res.status(500).json({ message: "Server error" });
  }
});

app.post("/set-category-limit", authenticate, async (req, res) => {
  try {
    const { category, limit } = req.body;
    const userId = req.userId; 

    if (!category || !limit) {
      return res.status(400).json({ message: "Category and limit are required" });
    }

    const existingLimit = await CategoryLimitModel.findOne({ userId, category });

    if (existingLimit) {
      existingLimit.limit = limit;
      await existingLimit.save();
      return res.status(200).json({ message: "Category limit updated successfully" });
    }

    const newLimit = new CategoryLimitModel({ userId, category, limit });
    await newLimit.save();

    return res.status(201).json({ message: "Category limit set successfully" });

  } catch (err) {
    console.error("Error setting category limit:", err);
    return res.status(500).json({ message: "Server error" });
  }
});




const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
