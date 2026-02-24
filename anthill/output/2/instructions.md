# Podomoro: Web Application Instructions

## Overview

Podomoro is a web application designed to help users track their daily steps and progress toward health goals. It provides a simple, intuitive interface for logging steps, visualizing progress, and setting personal targets.

## Installation

### Prerequisites

- Node.js (v18.17.0 or higher)
- npm (v9.0.0 or higher)

### Installation Steps

1. **Clone the repository**:
   ```bash
   git clone https://github.com/your-username/podomoro.git
   ```

2. **Install dependencies**:
   ```bash
   cd podomoro
   npm install
   ```

## Running the Application

### Development Mode

To start the development server:


npm run dev

This will launch the application at `http://localhost:3000`.

### Production Mode

To build the application for production:


npm run build

This will generate the production-ready files in the `dist` directory.

## Features

- **Step Tracking**: Log daily steps manually or via integration with step counters.
- **Progress Visualization**: Real-time charts showing step progress against weekly goals.
- **Goal Setting**: Set personalized daily and weekly step targets.
- **Data Export**: Export step data to CSV for analysis.

## Configuration

### Environment Variables

Create a `.env` file in the root directory with the following variables:


VITE_API_URL=https://api.podomoro.example
VITE_API_KEY=your_api_key_here

### Customization

Modify the `src/config.js` file to adjust default step goals and other application settings.

## Testing

### Unit Tests

Run the unit tests with:


npm run test

### End-to-End Tests

Run the end-to-end tests with:


npm run e2e

## Contributing

To contribute to Podomoro:

1. Fork the repository.
2. Create a new branch (`git checkout -b feature/your-feature`).
3. Commit your changes (`git commit -m "Add some feature"`).
4. Push to the branch (`git push origin feature/your-feature`).
5. Open a pull request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

For help or issues, contact the project maintainers at:
support@podomoro.example

## User Instructions

### Getting Started

1. **Open the application**:
   - Visit `http://localhost:3000` in your web browser after running `npm run dev`.
2. **Log in or sign up**:
   - If you don't have an account, click **Sign Up** to create a new account.
   - Use your email and a secure password to log in.

### Logging Steps

1. **Manual Entry**:
   - Go to the **Steps** tab.
   - Enter the number of steps for the day.
   - Click **Save**.
2. **Step Counter Integration** (if supported by your device):
   - Enable step counter integration in the app settings.
   - The app will automatically log steps from your device.

### Viewing Progress

1. **Daily Progress**:
   - Navigate to the **Progress** tab.
   - View your current step count and compare it with your daily goal.
2. **Weekly Progress**:
   - Use the weekly chart to see how you're progressing toward your weekly goal.

### Setting Goals

1. **Daily Goal**:
   - Go to the **Settings** tab.
   - Under **Daily Goal**, enter your target steps for the day.
2. **Weekly Goal**:
   - In the same settings, set your weekly goal (e.g., 10,000 steps).

### Exporting Data

1. **Export to CSV**:
   - Go to the **Export** tab.
   - Click **Export Data**.
   - Choose the date range and click **Generate CSV**.
   - The CSV file will be downloaded to your device.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

For help or issues, contact the project maintainers at:
support@podomoro.example